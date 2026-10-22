const { CMD } = require('./protocol');
const { state, publish, appendAudit } = require('./state');
const serial = require('./serial');
const admin = require('./admin');

function floatBuffer(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeFloatLE(Number(value) || 0);
    return buffer;
}

function guard() {
    if (!admin.isUnlocked()) return 'Admin session is locked.';
    if (state.sweep.running) return 'Stop the active sweep before writing calibration.';
    return null;
}

async function setScaler({ channel, mode, value }) {
    const blocked = guard();
    if (blocked) return { ok: false, acknowledged: false, message: blocked };
    const payload = Buffer.concat([Buffer.from([channel]), floatBuffer(value), Buffer.from([mode])]);
    try {
        await serial.sendBinary(CMD.SET_SCALER, payload, { source: 'calibrator' });
        const readBack = await serial.sendBinary(CMD.GET_SCALERS, Buffer.alloc(0), { source: 'calibrator' });
        const newValue = readBack.readFloatLE(channel * 4);
        return { ok: true, acknowledged: true, message: `Scaler channel ${channel} confirmed at ${newValue}`, newValue };
    } catch (error) {
        appendAudit({ source: 'calibrator', command: CMD.SET_SCALER, payload: [...payload], result: 'failed', error: error.message });
        return { ok: false, acknowledged: false, message: `Write not acknowledged: ${error.message}` };
    }
}

async function getScalers() {
    const readBack = await serial.sendBinary(CMD.GET_SCALERS, Buffer.alloc(0), { source: 'calibrator' });
    return { lift: readBack.readFloatLE(0), drag: readBack.readFloatLE(4), pressure: readBack.readFloatLE(8) };
}

const LUT_SIZE = 10;
// The firmware writes each entry to EEPROM before it parses the next command, and the legacy
// calibrator waits 100ms between its write and its read-back; reading straight after a write
// can return the old table.
const LUT_WRITE_GAP_MS = 50;
const LUT_SETTLE_MS = 150;
// The firmware reports LUT entries to 2 decimal places.
const LUT_READBACK_TOLERANCE = 0.011;
// Sanity ceiling (the tunnel tops out around 34 m/s) so a glitching pressure reading cannot be persisted to EEPROM.
const LUT_MAX_VELOCITY = 100;
// Used when running with --simulate (no controller): matches the firmware's default table.
const simulatedLut = [8.77, 12.52, 14.62, 17.32, 19.62, 22.25, 24.15, 26.28, 28.48, 29.73];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getLut() {
    if (state.simulation) return [...simulatedLut];
    const readBack = await serial.sendBinary(CMD.GET_LUT, Buffer.alloc(0), { source: 'calibrator' });
    const entries = [];
    for (let index = 0; index < LUT_SIZE; index += 1) entries.push(readBack.readFloatLE(index * 4));
    return entries;
}

// Writes the whole table in one operation: all ten entries, then a single read-back. `acknowledged`
// is only true when the controller reports every entry back at the value that was sent.
async function setLutTable({ velocities }) {
    const blocked = guard();
    if (blocked) return { ok: false, acknowledged: false, message: blocked };
    if (!Array.isArray(velocities) || velocities.length !== LUT_SIZE) {
        return { ok: false, acknowledged: false, message: `Velocity table needs ${LUT_SIZE} entries.` };
    }
    const values = velocities.map((velocity) => (velocity === null || String(velocity).trim() === '' ? NaN : Number(velocity)));
    const invalid = values.map((value, index) => (Number.isFinite(value) && value >= 0 && value <= LUT_MAX_VELOCITY ? null : `${(index + 1) * 10}%`)).filter(Boolean);
    if (invalid.length) {
        return { ok: false, acknowledged: false, message: `Enter a velocity between 0 and ${LUT_MAX_VELOCITY} m/s for every fan step (missing/invalid: ${invalid.join(', ')}).` };
    }

    if (state.simulation) {
        values.forEach((value, index) => { simulatedLut[index] = Number(value.toFixed(2)); });
        return { ok: true, acknowledged: true, message: 'Velocity table written and confirmed (simulation).', entries: [...simulatedLut] };
    }

    let written = 0;
    try {
        for (let index = 0; index < LUT_SIZE; index += 1) {
            const payload = Buffer.concat([Buffer.from([index]), floatBuffer(values[index])]);
            await serial.sendBinary(CMD.SET_LUT, payload, { source: 'calibrator' });
            written += 1;
            await wait(LUT_WRITE_GAP_MS);
        }
        await wait(LUT_SETTLE_MS);
        const entries = await getLut();
        const mismatched = entries
            .map((entry, index) => ({ index, sent: values[index], read: entry }))
            .filter(({ sent, read }) => !(Math.abs(read - sent) <= LUT_READBACK_TOLERANCE));
        if (mismatched.length) {
            const detail = mismatched.map(({ index, sent, read }) => `${(index + 1) * 10}% sent ${sent} read ${Number.isFinite(read) ? read : 'blank'}`).join('; ');
            return { ok: false, acknowledged: false, message: `Controller did not confirm every entry (${detail}). Your values are kept - press Save again or Refresh to re-read.`, entries };
        }
        return { ok: true, acknowledged: true, message: 'Velocity table written and confirmed by the controller.', entries };
    } catch (error) {
        appendAudit({ source: 'calibrator', command: CMD.SET_LUT, payload: [], result: 'failed', error: error.message });
        return { ok: false, acknowledged: false, message: `Write not acknowledged after ${written}/${LUT_SIZE} entries: ${error.message}` };
    }
}

// Fan step for the pressure-to-velocity capture. Same admin + idle gate as every calibration write,
// so the fan cannot be driven up from here while a sweep owns it. Stopping (0%) is always allowed:
// an expired admin session must never leave the capture's fan running with no way to stop it here.
async function setLutFan({ percent }) {
    const requested = Number(percent);
    if (!Number.isFinite(requested)) return { ok: false, message: 'Fan speed must be a number.' };
    const target = Math.min(100, Math.max(0, Math.round(requested)));
    if (target > 0) {
        const blocked = guard();
        if (blocked) return { ok: false, message: blocked };
    }
    if (state.simulation) {
        await serial.setFanSpeed(target, { source: 'calibrator' });
        return { ok: true, fanSpeed: state.fanSpeed, message: `Fan set to ${target}%` };
    }
    // serial.setFanSpeed swallows send errors, so send directly: the capture must know the fan really moved.
    try {
        await serial.sendBinary(CMD.FAN_SPEED, Buffer.from([target]), { source: 'calibrator' });
    } catch (error) {
        state.diagnostics.errors += 1;
        publish();
        return { ok: false, message: `Fan command failed: ${error.message}` };
    }
    state.fanSpeed = target;
    publish();
    return { ok: true, fanSpeed: target, message: `Fan set to ${target}%` };
}

async function calibrateDisplay() {
    const blocked = guard();
    if (blocked) return { ok: false, acknowledged: false, message: blocked };
    try {
        await serial.sendBinary(CMD.CALIBRATE_DISPLAY, Buffer.alloc(0), { source: 'calibrator' });
        return { ok: true, acknowledged: true, message: 'Display calibration command acknowledged.' };
    } catch (error) {
        return { ok: false, acknowledged: false, message: `Write not acknowledged: ${error.message}` };
    }
}

async function setNetwork({ ip0, ip1, ip2, ip3, port }) {
    const blocked = guard();
    if (blocked) return { ok: false, acknowledged: false, message: blocked };
    const payload = Buffer.alloc(6);
    payload[0] = ip0; payload[1] = ip1; payload[2] = ip2; payload[3] = ip3;
    payload.writeUInt16LE(port, 4);
    try {
        await serial.sendBinary(CMD.SET_NETWORK, payload, { source: 'calibrator' });
        return { ok: true, acknowledged: true, message: `Network address ${ip0}.${ip1}.${ip2}.${ip3}:${port} acknowledged.` };
    } catch (error) {
        return { ok: false, acknowledged: false, message: `Write not acknowledged: ${error.message}` };
    }
}

module.exports = { setScaler, getScalers, setLutTable, getLut, setLutFan, calibrateDisplay, setNetwork };
