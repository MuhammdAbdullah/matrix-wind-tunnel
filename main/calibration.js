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

const SCALER_CHANNELS = ['Lift', 'Drag', 'Pressure'];
const SCALER_ABSOLUTE = 0;
const SCALER_RELATIVE = 1;
const SCALER_MODE_NAMES = ['Absolute', 'Relative'];
// The legacy calibrator encodes scalers with 6 decimals ("AssignDataAsFloat(.., 6)") and the firmware
// reports them with 6 decimals, so that is the resolution the controller can confirm.
const SCALER_DECIMALS = 6;
// Sanity ceiling only: a typo such as 1e30 must not be persisted to EEPROM (real scalers are ~0.1-10).
const SCALER_MAX_MAGNITUDE = 1000000;
// V2.0.6 stores the scaler to EEPROM while it handles the command; the legacy calibrator also reads
// back straight after a write, but the table writes need ~100 ms, so give the scalers the same gap.
const SCALER_SETTLE_MS = 100;
// Used when running with --simulate (no controller): matches the firmware's default scalers.
const simulatedScalers = [0.755, 0.698, 0.15];

// Float32 -> the 6 decimal value the controller reports. Without this a float32 widened to a double
// shows up as e.g. 0.7549999952316284 in the UI and on the wire.
function roundScaler(value) {
    return Number(Number(value).toFixed(SCALER_DECIMALS));
}

// Mirrors the firmware's `senscmode` handling: Absolute replaces the stored scaler, Relative
// multiplies the stored scaler by the factor. Stored values are float32.
function expectedScaler(current, factor, mode) {
    return Math.fround(mode === SCALER_RELATIVE ? Math.fround(factor) * Math.fround(current) : Math.fround(factor));
}

// The controller reports 6 decimals of a float32, and a Relative result is computed from the (also
// 6 decimal) value that was read beforehand, so allow for both roundings.
function scalerMatches(read, expected, factor, mode) {
    if (!Number.isFinite(read)) return false;
    const tolerance = 1e-6 + 1e-6 * Math.abs(expected) + (mode === SCALER_RELATIVE ? 5e-7 * Math.abs(factor) : 0);
    return Math.abs(read - expected) <= tolerance;
}

// Only a number or plain digits: Number() alone would turn null/''/true/[1] into a channel or mode.
function parseSmallInteger(raw) {
    if (typeof raw === 'number') return Number.isInteger(raw) ? raw : NaN;
    if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw.trim());
    return NaN;
}

// Plain decimal notation (optionally with an exponent) only: Number() also accepts '0x10', '0b1', '' and [1].
const SCALER_TEXT_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function parseScalerRequest({ channel, mode, value }) {
    const channelNumber = parseSmallInteger(channel);
    if (!(channelNumber >= 0 && channelNumber < SCALER_CHANNELS.length)) {
        return { error: 'Scaler channel must be 0 (lift), 1 (drag) or 2 (pressure).' };
    }
    const modeNumber = parseSmallInteger(mode);
    if (modeNumber !== SCALER_ABSOLUTE && modeNumber !== SCALER_RELATIVE) {
        return { error: 'Scaler mode must be 0 (Absolute) or 1 (Relative).' };
    }
    // Number('') is 0 and Number('abc') is NaN: neither may reach the EEPROM as a silent 0.
    let factor = NaN;
    if (typeof value === 'number') factor = value;
    else if (typeof value === 'string' && SCALER_TEXT_PATTERN.test(value.trim())) factor = Number(value.trim());
    if (!Number.isFinite(factor)) return { error: `Enter a number for the ${SCALER_CHANNELS[channelNumber].toLowerCase()} scale factor (for example 0.95).` };
    const rounded = roundScaler(factor);
    if (rounded === 0) return { error: 'A scale factor of 0 would zero the sensor; enter a non-zero value (resolution is 0.000001).' };
    if (Math.abs(rounded) > SCALER_MAX_MAGNITUDE) return { error: `Scale factor must be between -${SCALER_MAX_MAGNITUDE} and ${SCALER_MAX_MAGNITUDE}.` };
    return { channel: channelNumber, mode: modeNumber, factor: rounded };
}

async function readScalerValues() {
    if (state.simulation) return [...simulatedScalers];
    const readBack = await serial.sendBinary(CMD.GET_SCALERS, Buffer.alloc(0), { source: 'calibrator' });
    const values = [0, 1, 2].map((index) => readBack.readFloatLE(index * 4));
    // A garbled reply must surface as an error, not as NaN fields or a NaN "old value" before a write.
    if (!values.every(Number.isFinite)) throw new Error('Controller returned an invalid scaler value');
    return values;
}

async function getScalers() {
    const [lift, drag, pressure] = (await readScalerValues()).map(roundScaler);
    return { lift, drag, pressure };
}

// Reads the scaler first (old value, and the base a Relative factor multiplies), writes, waits for the
// EEPROM write, then reads back. `acknowledged` is only true when the controller reports the value the
// firmware's own Absolute/Relative rule predicts - never from the write alone, which has no reply.
async function setScaler(request) {
    const blocked = guard();
    if (blocked) return { ok: false, acknowledged: false, message: blocked };
    const parsed = parseScalerRequest(request || {});
    if (parsed.error) return { ok: false, acknowledged: false, message: parsed.error };
    const { channel, mode, factor } = parsed;
    const label = `${SCALER_CHANNELS[channel]} scaler (${SCALER_MODE_NAMES[mode]})`;
    const payload = Buffer.concat([Buffer.from([channel]), floatBuffer(factor), Buffer.from([mode])]);

    let before;
    try {
        before = (await readScalerValues())[channel];
    } catch (error) {
        return { ok: false, acknowledged: false, message: `${label} not written - could not read the current scaler: ${error.message}` };
    }
    const oldValue = roundScaler(before);
    const expected = expectedScaler(before, factor, mode);
    // Relative can drive the stored scaler somewhere the factor alone never shows (0 stays 0, 1e-4 * 0.001 -> 0).
    const resulting = roundScaler(expected);
    if (mode === SCALER_RELATIVE && (oldValue === 0 || resulting === 0 || Math.abs(resulting) > SCALER_MAX_MAGNITUDE)) {
        const reason = oldValue === 0 ? 'the stored scaler is 0, so a Relative factor can never change it - use Absolute'
            : `the result would be ${resulting === 0 ? '0' : expected}, outside the usable range`;
        return { ok: false, acknowledged: false, oldValue, message: `${label} not written: ${reason}.` };
    }

    if (state.simulation) {
        simulatedScalers[channel] = roundScaler(expected);
        return { ok: true, acknowledged: true, oldValue, newValue: simulatedScalers[channel], message: `${label} written and confirmed (simulation): ${oldValue} -> ${simulatedScalers[channel]}.` };
    }

    let written = false;
    try {
        await serial.sendBinary(CMD.SET_SCALER, payload, { source: 'calibrator' });
        written = true;
        await wait(SCALER_SETTLE_MS);
        const after = (await readScalerValues())[channel];
        const newValue = roundScaler(after);
        if (!scalerMatches(after, expected, factor, mode)) {
            return {
                ok: false, acknowledged: false, oldValue, newValue,
                message: `${label} not confirmed: sent ${factor}, expected ${roundScaler(expected)} but the controller reports ${newValue} (was ${oldValue}). Press Refresh to re-read the controller.`
            };
        }
        return { ok: true, acknowledged: true, oldValue, newValue, message: `${label} confirmed by the controller: ${oldValue} -> ${newValue}.` };
    } catch (error) {
        appendAudit({ source: 'calibrator', command: CMD.SET_SCALER, payload: [...payload], result: 'failed', error: error.message });
        const detail = written ? `the write was sent but the read-back failed (${error.message}); press Refresh to see what the controller holds` : `write not acknowledged: ${error.message}`;
        return { ok: false, acknowledged: false, oldValue, message: `${label} ${detail}` };
    }
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
