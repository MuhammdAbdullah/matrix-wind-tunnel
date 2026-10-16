const { CMD, frame, parseFrames } = require('./protocol');
const { state, publish, clamp, simulateSensors, appendAudit, API_VERSION } = require('./state');

let SerialPort;
try { ({ SerialPort } = require('serialport')); } catch (_error) { SerialPort = null; }

const USB_VENDOR_ID = 0x12BF;
const USB_PRODUCT_ID = 0xF010;
const SCAN_INTERVAL_MS = 2000;
const MONITOR_INTERVAL_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 8000;
const READ_FAILURE_RECONNECT_THRESHOLD = 5;

let serialPort = null;
let serialBuffer = Buffer.alloc(0);
let commandQueue = Promise.resolve();
let pendingCommand = null;

let lastKnownPortPath = null;
let intentionalClose = false;
let reconnectInProgress = false;
let reconnectFailureStreak = 0;
let autoReconnectTimer = null;
let scanTimer = null;
let scanBusy = false;
let monitorTimer = null;
let consecutiveReadFailures = 0;

const disconnectListeners = [];

function onUnexpectedDisconnect(listener) {
    disconnectListeners.push(listener);
}

function notifyUnexpectedDisconnect(reason) {
    disconnectListeners.forEach((listener) => {
        try { listener(reason); } catch (_error) { /* listener errors must not break reconnect flow */ }
    });
}

function record(direction, data) {
    state.diagnostics[direction].push(`${new Date().toISOString()} ${data.toString('hex')}`);
    state.diagnostics[direction] = state.diagnostics[direction].slice(-100);
    publish();
}

// A rejected link in the chain must not permanently wedge every later command behind it.
function sendBinary(command, payload = Buffer.alloc(0), options = {}) {
    const { timeout = 2000, source = 'system' } = options;
    const attempt = commandQueue.then(() => new Promise((resolve, reject) => {
        if (!serialPort || !serialPort.isOpen) { reject(new Error('Controller is not connected')); return; }
        const packet = frame(command, payload);
        pendingCommand = {
            command,
            resolve,
            reject,
            timer: setTimeout(() => {
                pendingCommand = null;
                state.diagnostics.retries += 1;
                reject(new Error(`Timeout waiting for ${command}`));
            }, timeout)
        };
        record('tx', packet);
        serialPort.write(packet, (error) => {
            if (error && pendingCommand) { clearTimeout(pendingCommand.timer); pendingCommand.reject(error); pendingCommand = null; }
        });
    }));
    commandQueue = attempt.catch(() => {});
    attempt.then(
        () => appendAudit({ source, command, payload: [...payload], result: 'ack' }),
        (error) => appendAudit({ source, command, payload: [...payload], result: 'failed', error: error.message })
    );
    return attempt;
}

function parseResponse(response) {
    if (response[0] !== 0x3A || !pendingCommand || response[1] !== pendingCommand.command.charCodeAt(0)) return;
    const payload = response.subarray(2, response.length - 1);
    const request = pendingCommand;
    pendingCommand = null;
    clearTimeout(request.timer);
    request.resolve(payload);
}

function handleData(chunk) {
    serialBuffer = Buffer.concat([serialBuffer, chunk]);
    const parsed = parseFrames(serialBuffer);
    serialBuffer = parsed.remainder;
    record('rx', chunk);
    parsed.frames.forEach(parseResponse);
}

async function connectHardware(portPath, baudRate = 115200) {
    if (!SerialPort) throw new Error('SerialPort dependency is not installed');
    if (serialPort?.isOpen) await new Promise((resolve) => serialPort.close(resolve));
    serialPort = new SerialPort({ path: portPath, baudRate, autoOpen: false });
    serialPort.on('data', handleData);
    serialPort.on('error', () => { state.diagnostics.errors += 1; publish(); });
    serialPort.on('close', () => {
        state.connected = false;
        state.port = null;
        publish();
        if (intentionalClose) { intentionalClose = false; return; }
        notifyUnexpectedDisconnect('port closed');
        scheduleAutoReconnect();
    });
    await new Promise((resolve, reject) => serialPort.open((error) => (error ? reject(error) : resolve())));
    state.connected = true;
    state.simulation = false;
    state.port = portPath;
    publish();
    const version = await sendBinary(CMD.VERSION);
    if (!version.length || version[0] !== API_VERSION) {
        await new Promise((resolve) => serialPort.close(resolve));
        serialPort = null;
        state.connected = false;
        throw new Error(`Unsupported controller API version: ${version[0] ?? 'unknown'}`);
    }
    lastKnownPortPath = portPath;
    reconnectFailureStreak = 0;
    consecutiveReadFailures = 0;
    startConnectionMonitoring();
    return state;
}

function disconnect() {
    intentionalClose = true;
    clearTimeout(autoReconnectTimer);
    autoReconnectTimer = null;
    reconnectInProgress = false;
    lastKnownPortPath = null;
    if (serialPort?.isOpen) serialPort.close();
    serialPort = null;
    state.connected = false;
    state.port = null;
    state.simulation = false;
    state.fanSpeed = 0;
    publish();
}

function scheduleAutoReconnect() {
    if (state.simulation || reconnectInProgress || autoReconnectTimer || !lastKnownPortPath) return;
    const delay = Math.min(1000 * 2 ** reconnectFailureStreak, MAX_RECONNECT_DELAY_MS);
    autoReconnectTimer = setTimeout(async () => {
        autoReconnectTimer = null;
        reconnectInProgress = true;
        const targetPath = lastKnownPortPath;
        try {
            await connectHardware(targetPath, 115200);
        } catch (_error) {
            reconnectFailureStreak += 1;
            state.diagnostics.errors += 1;
            publish();
            lastKnownPortPath = targetPath;
            reconnectInProgress = false;
            scheduleAutoReconnect();
            return;
        }
        reconnectInProgress = false;
    }, delay);
}

function startConnectionMonitoring() {
    if (monitorTimer) return;
    monitorTimer = setInterval(() => {
        if (!state.connected) return;
        if (!serialPort || !serialPort.isOpen) {
            state.connected = false;
            state.port = null;
            publish();
            notifyUnexpectedDisconnect('port no longer open');
            scheduleAutoReconnect();
        }
    }, MONITOR_INTERVAL_MS);
}

function reportReadOutcome(ok) {
    if (ok) { consecutiveReadFailures = 0; return; }
    consecutiveReadFailures += 1;
    if (consecutiveReadFailures >= READ_FAILURE_RECONNECT_THRESHOLD && state.connected) {
        consecutiveReadFailures = 0;
        state.connected = false;
        publish();
        notifyUnexpectedDisconnect('sensor read failures');
        scheduleAutoReconnect();
    }
}

function findTargetPort(ports) {
    return ports.find((port) => String(port.vendorId || '').toUpperCase() === '12BF' && String(port.productId || '').toUpperCase() === 'F010');
}

function startAutoConnect() {
    if (scanTimer) return;
    const scan = async () => {
        if (scanBusy || state.connected || reconnectInProgress || autoReconnectTimer || !SerialPort) return;
        scanBusy = true;
        try {
            const ports = await SerialPort.list();
            const target = findTargetPort(ports);
            if (target) {
                try { await connectHardware(target.path, 115200); } catch (_error) { state.diagnostics.errors += 1; publish(); }
            }
        } finally { scanBusy = false; }
    };
    scan();
    scanTimer = setInterval(scan, SCAN_INTERVAL_MS);
}

async function listPorts() {
    return SerialPort ? SerialPort.list() : [];
}

async function setFanSpeed(value, options = {}) {
    state.fanSpeed = clamp(value, 0, 100);
    if (state.simulation) { simulateSensors(); return state; }
    try { await sendBinary(CMD.FAN_SPEED, Buffer.from([state.fanSpeed]), options); }
    catch (_error) { state.diagnostics.errors += 1; publish(); }
    return state;
}

async function setAngle(value, options = {}) {
    state.angle = clamp(value, -180, 180);
    if (state.simulation) { simulateSensors(); return state; }
    const payload = Buffer.alloc(2);
    payload.writeInt16LE(state.angle);
    try { await sendBinary(CMD.ANGLE, payload, options); }
    catch (_error) { state.diagnostics.errors += 1; publish(); }
    return state;
}

async function readSensorsOnce(options = {}) {
    if (state.simulation) return simulateSensors();
    const payload = await sendBinary(CMD.READ_SENSORS, Buffer.alloc(0), options);
    if (payload.length >= 16) {
        state.sensors = {
            lift: payload.readFloatLE(0),
            drag: payload.readFloatLE(4),
            pressure: payload.readFloatLE(8),
            velocity: payload.readFloatLE(12)
        };
    }
    return state.sensors;
}

module.exports = {
    USB_VENDOR_ID,
    USB_PRODUCT_ID,
    sendBinary,
    connectHardware,
    disconnect,
    startAutoConnect,
    listPorts,
    setFanSpeed,
    setAngle,
    readSensorsOnce,
    reportReadOutcome,
    onUnexpectedDisconnect
};
