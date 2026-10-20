const { CMD, frame, parseFrames, RESPONSE_PAYLOAD_LENGTH } = require('./protocol');
const { state, publish, clamp, simulateSensors, appendAudit, API_VERSION } = require('./state');

let SerialPort;
try { ({ SerialPort } = require('serialport')); } catch (error) { console.log(`[serial] Failed to load 'serialport' module: ${error.message}`); SerialPort = null; }

const USB_VENDOR_ID = 0x12BF;
const USB_PRODUCT_ID = 0xF010;
const SCAN_INTERVAL_MS = 2000;
const MONITOR_INTERVAL_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 8000;
const READ_FAILURE_RECONNECT_THRESHOLD = 5;
const MAX_FRAME_RETRIES = 2;
const RESPONSE_COMMANDS = new Set([CMD.VERSION, CMD.READ_SENSORS, CMD.GET_SCALERS, CMD.GET_LUT]);

let serialPort = null;
let serialBuffer = Buffer.alloc(0);
let jsonBuffer = '';
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

function jsonRequestFor(command, payload) {
    switch (command) {
        case CMD.VERSION: return { version: 0 };
        case CMD.FAN_SPEED: return { fanspeed: payload[0] };
        case CMD.READ_SENSORS: return { readsensors: 0 };
        case CMD.ANGLE: return { angle: payload.readInt16LE(0) };
        case CMD.ZERO_SENSORS: return { zerosensors: 0 };
        case CMD.ZERO_MOTOR: return { zeromotor: 0 };
        case CMD.LED: return {
            animmode: payload[0], animr: payload[1], animg: payload[2], animb: payload[3],
            ambmode: payload[4], ambr: payload[5], ambg: payload[6], ambb: payload[7]
        };
        case CMD.SET_SCALER: return { senscch: payload[0], senscale: payload.readFloatLE(1), senscmode: payload[5] };
        case CMD.GET_SCALERS: return { getsensorscalers: 0 };
        case CMD.SET_LUT: return { setvluchan: payload[0], setvluvel: payload.readFloatLE(1) };
        case CMD.GET_LUT: return { getvlu: 0 };
        case CMD.CALIBRATE_DISPLAY: return { calibratedisplay: 0 };
        case CMD.SET_NETWORK: return { ip0: payload[0], ip1: payload[1], ip2: payload[2], ip3: payload[3], port: payload.readUInt16LE(4) };
        default: throw new Error(`Unsupported command ${command}`);
    }
}

function responseToPayload(command, response) {
    if (command === CMD.VERSION) return Buffer.from([Number(response.version)]);
    if (command === CMD.READ_SENSORS) {
        const payload = Buffer.alloc(16);
        ['lift', 'drag', 'pressure', 'velocity'].forEach((key, index) => payload.writeFloatLE(Number(response[key]), index * 4));
        return payload;
    }
    if (command === CMD.GET_SCALERS) {
        const payload = Buffer.alloc(12);
        ['sl', 'sd', 'sp'].forEach((key, index) => payload.writeFloatLE(Number(response[key]), index * 4));
        return payload;
    }
    if (command === CMD.GET_LUT) {
        const payload = Buffer.alloc(40);
        for (let index = 0; index < 10; index += 1) payload.writeFloatLE(Number(response[`vl${index}`]), index * 4);
        return payload;
    }
    return Buffer.alloc(0);
}

function sendJsonAttempt(command, payload, timeout, expectResponse = true) {
    return new Promise((resolve, reject) => {
        if (!serialPort || !serialPort.isOpen) { reject(new Error('Controller is not connected')); return; }
        const packet = Buffer.from(JSON.stringify(jsonRequestFor(command, payload)));
        pendingCommand = {
            command,
            resolve,
            reject,
            timer: setTimeout(() => {
                pendingCommand = null;
                reject(new Error(`Timeout waiting for ${command}`));
            }, timeout)
        };
        record('tx', packet);
        serialPort.write(packet, (error) => {
            if (error && pendingCommand) { clearTimeout(pendingCommand.timer); pendingCommand.reject(error); pendingCommand = null; }
            if (!error && !expectResponse && pendingCommand?.command === command) {
                clearTimeout(pendingCommand.timer);
                pendingCommand = null;
                resolve(Buffer.alloc(0));
            }
        });
    });
}

// V2.0.6's running application firmware consumes JSON and replies with one
// JSON object. It does not answer the legacy binary :A...; frames.
function sendBinaryAttempt(command, payload, timeout, expectResponse) {
    return sendJsonAttempt(command, payload, timeout, expectResponse);
}

// A rejected link in the chain must not permanently wedge every later command behind it.
// A single missed/garbled reply is retried in place before giving up, per the
// documented "2000ms timeout, two retries" transport behaviour.
function sendBinary(command, payload = Buffer.alloc(0), options = {}) {
    const { timeout = 2000, source = 'system', retries = MAX_FRAME_RETRIES, expectResponse = RESPONSE_COMMANDS.has(command) } = options;
    const attempt = commandQueue.then(async () => {
        let lastError;
        for (let attemptNumber = 0; attemptNumber <= retries; attemptNumber += 1) {
            try {
                return await sendBinaryAttempt(command, payload, timeout, expectResponse);
            } catch (error) {
                lastError = error;
                state.diagnostics.retries += 1;
                if (attemptNumber < retries) console.log(`[serial] ${command} timed out, retrying (${attemptNumber + 1}/${retries})`);
            }
        }
        throw lastError;
    });
    commandQueue = attempt.catch(() => {});
    attempt.then(
        () => appendAudit({ source, command, payload: [...payload], result: 'ack' }),
        (error) => appendAudit({ source, command, payload: [...payload], result: 'failed', error: error.message })
    );
    return attempt;
}

function parseResponse(response) {
    if (response[0] !== 0x3A || !pendingCommand || response[1] !== pendingCommand.command.charCodeAt(0)) return;
    const payload = response.subarray(2, response.length - 2);
    const request = pendingCommand;
    pendingCommand = null;
    clearTimeout(request.timer);
    request.resolve(payload);
}

function handleData(chunk) {
    record('rx', chunk);
    jsonBuffer += chunk.toString('utf8');
    console.log(`[serial] RX ${chunk.length}B: ${chunk.toString('hex')}`);
    while (true) {
        const start = jsonBuffer.indexOf('{');
        if (start < 0) { jsonBuffer = ''; return; }
        const end = jsonBuffer.indexOf('}', start + 1);
        if (end < 0) { jsonBuffer = jsonBuffer.slice(start); return; }
        const text = jsonBuffer.slice(start, end + 1);
        jsonBuffer = jsonBuffer.slice(end + 1);
        if (!pendingCommand) continue;
        try {
            const response = JSON.parse(text);
            const request = pendingCommand;
            pendingCommand = null;
            clearTimeout(request.timer);
            request.resolve(responseToPayload(request.command, response));
        } catch (_error) {
            console.log(`[serial] Ignoring malformed JSON response: ${text}`);
        }
    }
}

async function connectHardware(portPath, baudRate = 115200) {
    if (!SerialPort) throw new Error('SerialPort dependency is not installed');
    console.log(`[serial] Opening ${portPath} @ ${baudRate}...`);
    if (serialPort?.isOpen) await new Promise((resolve) => serialPort.close(resolve));
    serialPort = new SerialPort({ path: portPath, baudRate, autoOpen: false, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false, dtr: true, rts: true });
    jsonBuffer = '';
    serialPort.on('data', handleData);
    serialPort.on('error', (error) => { console.log(`[serial] Port error: ${error.message}`); state.diagnostics.errors += 1; publish(); });
    serialPort.on('close', () => {
        console.log('[serial] Port closed');
        state.connected = false;
        state.port = null;
        publish();
        if (intentionalClose) { intentionalClose = false; return; }
        notifyUnexpectedDisconnect('port closed');
        scheduleAutoReconnect();
    });
    try {
        await new Promise((resolve, reject) => serialPort.open((error) => (error ? reject(error) : resolve())));
    } catch (error) {
        console.log(`[serial] Failed to open ${portPath}: ${error.message}`);
        serialPort = null;
        throw error;
    }
    state.connected = true;
    state.simulation = false;
    state.port = portPath;
    publish();
    console.log(`[serial] Port open, requesting API version...`);
    let version;
    try {
        version = await sendBinary(CMD.VERSION);
    } catch (error) {
        console.log(`[serial] Version read failed: ${error.message}`);
        if (serialPort?.isOpen) await new Promise((resolve) => serialPort.close(resolve));
        serialPort = null;
        state.connected = false;
        state.port = null;
        publish();
        throw error;
    }
    if (!version.length || version[0] !== API_VERSION) {
        console.log(`[serial] Unsupported API version: ${version[0] ?? 'unknown'}`);
        await new Promise((resolve) => serialPort.close(resolve));
        serialPort = null;
        state.connected = false;
        state.port = null;
        publish();
        throw new Error(`Unsupported controller API version: ${version[0] ?? 'unknown'}`);
    }
    console.log(`[serial] Connected, API version ${version[0]}`);
    lastKnownPortPath = portPath;
    reconnectFailureStreak = 0;
    consecutiveReadFailures = 0;
    startConnectionMonitoring();
    // Whatever the controller was doing before this session (or before a link drop) is stale.
    await enterSafeState('system');
    return state;
}

// Fan off and motor back to zero angle, sent in the transport's own format
// (sendBinary picks the JSON/binary encoding for the verified API version).
// Never throws: it runs on startup and during shutdown where nothing can recover from it.
async function enterSafeState(source = 'system') {
    state.fanSpeed = 0;
    state.angle = 0;
    if (!state.simulation && serialPort?.isOpen) {
        for (const [command, payload] of [[CMD.FAN_SPEED, Buffer.from([0])], [CMD.ZERO_MOTOR, Buffer.alloc(0)]]) {
            try { await sendBinary(command, payload, { source }); }
            catch (error) {
                console.log(`[serial] Safe-state ${command} failed: ${error.message}`);
                state.diagnostics.errors += 1;
            }
        }
    }
    publish();
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
    console.log(`[serial] Scheduling reconnect in ${delay}ms`);
    autoReconnectTimer = setTimeout(async () => {
        autoReconnectTimer = null;
        reconnectInProgress = true;
        const targetPath = lastKnownPortPath;
        try {
            await connectHardware(targetPath, 115200);
        } catch (error) {
            console.log(`[serial] Reconnect attempt failed: ${error.message}`);
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
        console.log(`[serial] ${consecutiveReadFailures} consecutive sensor read failures, forcing reconnect`);
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
    if (!SerialPort) console.log('[serial] SerialPort module is not available; USB auto-connect disabled');
    if (scanTimer) return;
    const scan = async () => {
        if (scanBusy || state.connected || reconnectInProgress || autoReconnectTimer || !SerialPort) return;
        scanBusy = true;
        try {
            const ports = await SerialPort.list();
            console.log(`[serial] Scanning... ${ports.length} port(s): ${ports.map((p) => `${p.path}(${p.vendorId || '?'}:${p.productId || '?'})`).join(', ') || 'none'}`);
            const target = findTargetPort(ports);
            if (target) {
                console.log(`[serial] Target device found at ${target.path}`);
                try { await connectHardware(target.path, 115200); } catch (error) { console.log(`[serial] Connect attempt failed: ${error.message}`); state.diagnostics.errors += 1; publish(); }
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

async function setLeds(options = {}) {
    const { animMode, animColor, ambMode, ambColor, source } = options;
    const clampByte = (n, fallback) => Math.round(clamp(n ?? fallback, 0, 255));
    const leds = state.leds;
    leds.animMode = Math.round(clamp(animMode ?? leds.animMode, 0, 4));
    leds.animColor = {
        r: clampByte(animColor?.r, leds.animColor.r),
        g: clampByte(animColor?.g, leds.animColor.g),
        b: clampByte(animColor?.b, leds.animColor.b)
    };
    leds.ambMode = Math.round(clamp(ambMode ?? leds.ambMode, 0, 3));
    leds.ambColor = {
        r: clampByte(ambColor?.r, leds.ambColor.r),
        g: clampByte(ambColor?.g, leds.ambColor.g),
        b: clampByte(ambColor?.b, leds.ambColor.b)
    };

    if (state.simulation) { publish(); return state; }

    const payload = Buffer.from([
        leds.animMode,
        leds.animColor.r, leds.animColor.g, leds.animColor.b,
        leds.ambMode,
        leds.ambColor.r, leds.ambColor.g, leds.ambColor.b
    ]);
    try { await sendBinary(CMD.LED, payload, { source: source || 'control' }); }
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
        state.sensorSampleSeq += 1;
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
    setLeds,
    enterSafeState,
    readSensorsOnce,
    reportReadOutcome,
    onUnexpectedDisconnect
};
