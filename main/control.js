const { CMD } = require('./protocol');
const { state, publish } = require('./state');
const serial = require('./serial');

// The operator-facing hardware commands (fan, angle, zero, LEDs), shared by the local IPC handlers
// in main.js and by the relay in main/network.js so a remote controller exercises exactly the same
// code path -- clamping, simulation handling, audit -- as the local Control view.
//
// When this app is itself a remote client (state.transport === 'remote') there is no hardware link
// here: the call is forwarded to the master instead. network.js registers the forwarder; control.js
// never requires it, which keeps the module graph acyclic.
let forwarder = null;

function setRemoteForwarder(fn) {
    forwarder = fn;
}

const isRemote = () => state.transport === 'remote';

async function setFanSpeed(value, source = 'control') {
    if (isRemote()) return forwarder('setFanSpeed', [value]);
    return serial.setFanSpeed(value, { source });
}

async function setAngle(value, source = 'control') {
    if (isRemote()) return forwarder('setAngle', [value]);
    return serial.setAngle(value, { source });
}

async function setLeds(payload, source = 'control') {
    if (isRemote()) return forwarder('setLeds', [payload]);
    return serial.setLeds({ ...payload, source });
}

async function zeroSensors(source = 'control') {
    if (isRemote()) return forwarder('zeroSensors', []);
    if (!state.simulation) await serial.sendBinary(CMD.ZERO_SENSORS, Buffer.alloc(0), { source });
    return { ok: true, message: 'Sensor zero command queued' };
}

async function zeroMotor(source = 'control') {
    if (isRemote()) return forwarder('zeroMotor', []);
    if (!state.simulation) await serial.sendBinary(CMD.ZERO_MOTOR, Buffer.alloc(0), { source });
    state.angle = 0;
    publish();
    return state;
}

module.exports = { setRemoteForwarder, setFanSpeed, setAngle, setLeds, zeroSensors, zeroMotor };
