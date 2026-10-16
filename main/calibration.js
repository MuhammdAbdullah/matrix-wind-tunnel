const { CMD } = require('./protocol');
const { state, appendAudit } = require('./state');
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

async function setLutEntry({ index, velocity }) {
    const blocked = guard();
    if (blocked) return { ok: false, acknowledged: false, message: blocked };
    const payload = Buffer.concat([Buffer.from([index]), floatBuffer(velocity)]);
    try {
        await serial.sendBinary(CMD.SET_LUT, payload, { source: 'calibrator' });
        const readBack = await serial.sendBinary(CMD.GET_LUT, Buffer.alloc(0), { source: 'calibrator' });
        const newValue = readBack.readFloatLE(index * 4);
        return { ok: true, acknowledged: true, message: `LUT index ${index} confirmed at ${newValue} m/s`, newValue };
    } catch (error) {
        appendAudit({ source: 'calibrator', command: CMD.SET_LUT, payload: [...payload], result: 'failed', error: error.message });
        return { ok: false, acknowledged: false, message: `Write not acknowledged: ${error.message}` };
    }
}

async function getLut() {
    const readBack = await serial.sendBinary(CMD.GET_LUT, Buffer.alloc(0), { source: 'calibrator' });
    const entries = [];
    for (let index = 0; index < 10; index += 1) entries.push(readBack.readFloatLE(index * 4));
    return entries;
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

module.exports = { setScaler, getScalers, setLutEntry, getLut, calibrateDisplay, setNetwork };
