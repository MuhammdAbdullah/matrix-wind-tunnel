const { CMD } = require('./protocol');
const { state, publish, clamp, simulateSensors, appendAudit, API_VERSION } = require('./state');

let SerialPort;
try { ({ SerialPort } = require('serialport')); } catch (error) { console.log(`[serial] Failed to load 'serialport' module: ${error.message}`); SerialPort = null; }

const USB_VENDOR_ID = 0x12BF;
const USB_PRODUCT_ID = 0xF010;
const SCAN_INTERVAL_MS = 2000;
const RESCAN_AFTER_LOSS_MS = 500;
const MAX_CONNECT_BACKOFF_MS = 4000;
const OPEN_TIMEOUT_MS = 5000;
const CLOSE_TIMEOUT_MS = 3000;
const MAX_FRAME_RETRIES = 2;
const MAX_JSON_BUFFER = 2048;
// The controller's API only comes up ~3-4 s after the COM port appears (splash screen + sensor
// warm-up), so the connect handshake is far more patient than steady-state commands.
const HANDSHAKE_TIMEOUT_MS = 1500;
const HANDSHAKE_RETRIES = 5;
// Link watchdog: the firmware sends nothing unsolicited, so liveness is "time since the last valid
// reply". The lost threshold sits above the firmware's worst legitimate service gap (a held touch
// blocks the API for up to ~5 s).
const WATCHDOG_INTERVAL_MS = 500;
const HEARTBEAT_AFTER_MS = 1500;
const HEARTBEAT_TIMEOUT_MS = 1500;
const LINK_DEGRADED_MS = 3000;
const LINK_LOST_MS = 8000;
// Commands after which the firmware can legitimately stay silent for a while (EEPROM writes, W5500
// re-init, the touch calibration screen). The watchdog treats the grace window as "recent activity".
const WATCHDOG_GRACE_MS = {
    [CMD.CALIBRATE_DISPLAY]: 60000,
    [CMD.SET_NETWORK]: 10000,
    [CMD.SET_SCALER]: 3000,
    [CMD.SET_LUT]: 3000,
    [CMD.GET_LUT]: 3000
};
const SERIAL_DEBUG = process.env.WIND_TUNNEL_SERIAL_DEBUG === '1';
const RESPONSE_COMMANDS = new Set([CMD.VERSION, CMD.READ_SENSORS, CMD.GET_SCALERS, CMD.GET_LUT]);
const LUT_KEYS = Array.from({ length: 10 }, (_unused, index) => `vl${index}`);
// A reply object only resolves the pending command if it carries every one of that command's keys as
// a finite number; anything else (e.g. the late second half of a getvlu reply after a retry, or a
// partial reading) is a stray and is ignored so it can never overwrite valid data.
const RESPONSE_KEYS = {
    [CMD.VERSION]: ['version'],
    [CMD.READ_SENSORS]: ['lift', 'drag', 'pressure', 'velocity'],
    [CMD.GET_SCALERS]: ['sl', 'sd', 'sp']
};

// Thrown when the link itself is gone (as opposed to one command timing out): never retried.
class LinkError extends Error {
    constructor(message) { super(message); this.name = 'LinkError'; this.linkDown = true; }
}

let serialPort = null;
let jsonBuffer = '';
let commandQueue = Promise.resolve();
let pendingCommand = null;
// Bumped whenever a session ends or begins. Queued work captures it when enqueued and refuses to
// run against a different session, so stale commands can never replay onto a reconnected port.
let linkGeneration = 0;
let queuedCommands = 0;

let lastKnownPortPath = null;
let connectInFlight = false;
let connectFailureStreak = 0;
let nextConnectAttemptAt = 0;
let scanTimer = null;
let rescanTimer = null;
let scanBusy = false;
let watchdogTimer = null;
let lastRxOkAt = 0;
let watchdogGraceUntil = 0;
let lastPortSignature = null;

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
        // Same 6-decimal float encoding as the legacy calibrator (and as SET_LUT below); the key order is
        // the firmware's order of evaluation: channel, factor, then mode applies it.
        case CMD.SET_SCALER: return { senscch: payload[0], senscale: Number(payload.readFloatLE(1).toFixed(6)), senscmode: payload[5] };
        case CMD.GET_SCALERS: return { getsensorscalers: 0 };
        // toFixed(6) matches the legacy calibrator's 6-decimal float encoding; a raw float32 widened to
        // a double would be sent as e.g. 5.650000095367432.
        case CMD.SET_LUT: return { setvluchan: payload[0], setvluvel: Number(payload.readFloatLE(1).toFixed(6)) };
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

function rejectPending(error) {
    const request = pendingCommand;
    if (!request) return;
    pendingCommand = null;
    clearTimeout(request.timer);
    request.reject(error);
}

function sendJsonAttempt(command, payload, timeout, expectResponse = true) {
    return new Promise((resolve, reject) => {
        const port = serialPort;
        if (!port || !port.isOpen) { reject(new LinkError('Controller is not connected')); return; }
        const packet = Buffer.from(JSON.stringify(jsonRequestFor(command, payload)));
        const request = { command, resolve, reject, timer: null };
        // Identity checks: a timer or write callback from an earlier attempt must never clear or
        // reject a newer command that has since become the pending one.
        request.timer = setTimeout(() => {
            if (pendingCommand === request) pendingCommand = null;
            reject(new Error(`Timeout waiting for ${command}`));
        }, timeout);
        pendingCommand = request;
        record('tx', packet);
        const onWritten = (error) => {
            if (error) {
                if (pendingCommand === request) pendingCommand = null;
                clearTimeout(request.timer);
                reject(new LinkError(`Write failed: ${error.message}`));
                markLinkLost(`write failed: ${error.message}`, port);
                return;
            }
            if (!expectResponse && pendingCommand === request) {
                clearTimeout(request.timer);
                pendingCommand = null;
                resolve(Buffer.alloc(0));
            }
        };
        try { port.write(packet, onWritten); }
        catch (error) { onWritten(error); }
    });
}

// V2.0.6's running application firmware consumes JSON and replies with one
// JSON object. It does not answer the legacy binary :A...; frames.
function sendBinaryAttempt(command, payload, timeout, expectResponse) {
    return sendJsonAttempt(command, payload, timeout, expectResponse);
}

function isLinkUsable() {
    return Boolean(state.connected && serialPort && serialPort.isOpen);
}

// A rejected link in the chain must not permanently wedge every later command behind it.
// A single missed/garbled reply is retried in place before giving up, per the
// documented "2000ms timeout, two retries" transport behaviour. A dead link is never retried and
// fails immediately instead of waiting out the queue; `handshake` is the connect-time bypass used
// before the session is marked connected, and `audit: false` keeps the watchdog's heartbeats out of
// the Admin audit log.
function sendBinary(command, payload = Buffer.alloc(0), options = {}) {
    const { timeout = 2000, source = 'system', retries = MAX_FRAME_RETRIES, expectResponse = RESPONSE_COMMANDS.has(command), handshake = false, audit = true } = options;
    const auditEntry = (result, error) => {
        if (!audit) return;
        appendAudit({ source, command, payload: [...payload], result, ...(error ? { error: error.message } : {}) });
    };
    if (!handshake && !isLinkUsable()) {
        const error = new LinkError('Controller is not connected');
        auditEntry('failed', error);
        return Promise.reject(error);
    }
    const generation = linkGeneration;
    queuedCommands += 1;
    const attempt = commandQueue.then(async () => {
        let lastError;
        for (let attemptNumber = 0; attemptNumber <= retries; attemptNumber += 1) {
            if (generation !== linkGeneration) throw new LinkError('Connection was reset before the command could be sent');
            const grace = WATCHDOG_GRACE_MS[command];
            if (grace) watchdogGraceUntil = Math.max(watchdogGraceUntil, Date.now() + grace);
            try {
                return await sendBinaryAttempt(command, payload, timeout, expectResponse);
            } catch (error) {
                lastError = error;
                if (error.linkDown) throw error;
                state.diagnostics.retries += 1;
                if (attemptNumber < retries) console.log(`[serial] ${command} timed out, retrying (${attemptNumber + 1}/${retries})`);
            }
        }
        throw lastError;
    });
    commandQueue = attempt.catch(() => {});
    attempt.then(
        // Commands without a reply only prove the OS accepted the write, not that the controller
        // applied them, so they are audited as 'sent' rather than 'ack'.
        () => { queuedCommands -= 1; auditEntry(expectResponse ? 'ack' : 'sent'); },
        (error) => { queuedCommands -= 1; auditEntry('failed', error); }
    );
    return attempt;
}

function handleData(chunk) {
    record('rx', chunk);
    if (SERIAL_DEBUG) console.log(`[serial] RX ${chunk.length}B: ${chunk.toString('hex')}`);
    jsonBuffer += chunk.toString('utf8');
    while (true) {
        const end = jsonBuffer.indexOf('}');
        if (end < 0) {
            // No complete object yet: keep only the tail from the last '{', and never grow without bound.
            const start = jsonBuffer.lastIndexOf('{');
            jsonBuffer = start < 0 || jsonBuffer.length - start > MAX_JSON_BUFFER ? '' : jsonBuffer.slice(start);
            return;
        }
        // Replies are flat objects, so the object ending at the first '}' starts at the nearest '{'
        // before it -- this resynchronises past any garbage or truncated object ahead of it.
        const start = jsonBuffer.lastIndexOf('{', end);
        const text = start < 0 ? '' : jsonBuffer.slice(start, end + 1);
        jsonBuffer = jsonBuffer.slice(end + 1);
        if (!text) continue;
        let response;
        try { response = JSON.parse(text); }
        catch (_error) { console.log(`[serial] Ignoring malformed JSON response: ${text}`); continue; }
        if (!response || typeof response !== 'object') continue;
        // Any well-formed reply object proves the controller is alive, even a late one.
        lastRxOkAt = Date.now();
        const request = pendingCommand;
        if (!request) continue;
        if (request.command === CMD.GET_LUT) {
            // V2.0.6 answers getvlu with two JSON objects (vl0-vl4, then vl5-vl9 about 5ms later),
            // so keep waiting until all ten entries have arrived instead of resolving on the first.
            // Either half may arrive first after a retry, so any vl* key is accepted into the merge.
            if (!LUT_KEYS.some((key) => key in response)) continue;
            request.partial = { ...request.partial, ...response };
            if (!LUT_KEYS.every((key) => key in request.partial)) continue;
            response = request.partial;
        } else if (RESPONSE_KEYS[request.command] && !RESPONSE_KEYS[request.command].every((key) => Number.isFinite(Number(response[key])) && response[key] !== null && response[key] !== '')) {
            console.log(`[serial] Ignoring stray JSON response while waiting for ${request.command}: ${text}`);
            continue;
        }
        pendingCommand = null;
        clearTimeout(request.timer);
        request.resolve(responseToPayload(request.command, response));
    }
}

function withTimeout(promise, ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        promise.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
    });
}

// Close a port without ever throwing or hanging: a wedged native close must not block recovery.
function closePortQuietly(port) {
    if (!port) return Promise.resolve();
    return withTimeout(new Promise((resolve) => {
        try {
            if (!port.isOpen) { resolve(); return; }
            port.close(() => resolve());
        } catch (_error) { resolve(); }
    }), CLOSE_TIMEOUT_MS);
}

// Open with a hard time limit. If the open eventually completes after we gave up, close it again
// so the COM port is not left locked by a handle nobody owns.
function openPort(port) {
    return new Promise((resolve, reject) => {
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; reject(new Error(`Timed out opening ${port.path}`)); }, OPEN_TIMEOUT_MS);
        try {
            port.open((error) => {
                clearTimeout(timer);
                if (timedOut) { if (!error) closePortQuietly(port); return; }
                if (error) reject(error); else resolve();
            });
        } catch (error) { clearTimeout(timer); reject(error); }
    });
}

// Detach a port from the transport: later events from it are ignored (listeners check identity),
// its data is no longer parsed, and the handle is closed in the background.
function releasePort(port) {
    if (!port) return;
    port.removeAllListeners('data');
    closePortQuietly(port);
}

// The one place a session ends unexpectedly (close, error, end, write failure, watchdog expiry).
// Idempotent and bound to a specific port so late events from an old handle cannot touch the
// current session.
function markLinkLost(reason, port = serialPort) {
    if (!port || port !== serialPort) return;
    const wasConnected = state.connected;
    console.log(`[serial] Link lost: ${reason}`);
    serialPort = null;
    linkGeneration += 1;
    stopWatchdog();
    jsonBuffer = '';
    rejectPending(new LinkError(`Connection lost: ${reason}`));
    commandQueue = Promise.resolve();
    releasePort(port);
    state.connected = false;
    state.port = null;
    state.linkDegraded = false;
    publish();
    if (wasConnected) notifyUnexpectedDisconnect(reason);
    requestRescan(RESCAN_AFTER_LOSS_MS);
}

function bindPort(port) {
    port.on('data', (chunk) => { if (port === serialPort) handleData(chunk); });
    port.on('error', (error) => {
        console.log(`[serial] Port error: ${error.message}`);
        if (port !== serialPort) return;
        state.diagnostics.errors += 1;
        // An error on the active port means the stream is unusable (serialport destroys it).
        markLinkLost(`port error: ${error.message}`, port);
    });
    port.on('end', () => markLinkLost('port stream ended', port));
    port.on('close', (error) => markLinkLost(error?.disconnected ? 'device disconnected' : 'port closed', port));
}

async function connectHardware(portPath, baudRate = 115200) {
    if (!SerialPort) throw new Error('SerialPort dependency is not installed');
    if (connectInFlight) throw new Error('A connection attempt is already in progress');
    connectInFlight = true;
    state.connecting = true;
    publish();
    try {
        return await openSession(portPath, baudRate);
    } finally {
        connectInFlight = false;
        state.connecting = false;
        publish();
    }
}

async function openSession(portPath, baudRate) {
    console.log(`[serial] Opening ${portPath} @ ${baudRate}...`);
    if (serialPort) markLinkLost('replaced by a new connection', serialPort);
    stopWatchdog();
    linkGeneration += 1;
    const port = new SerialPort({ path: portPath, baudRate, autoOpen: false, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false, dtr: true, rts: true });
    serialPort = port;
    jsonBuffer = '';
    bindPort(port);

    const abandon = () => {
        if (serialPort === port) {
            serialPort = null;
            linkGeneration += 1;
            rejectPending(new LinkError('Connection attempt abandoned'));
            commandQueue = Promise.resolve();
        }
        jsonBuffer = '';
        releasePort(port);
    };

    try {
        await openPort(port);
    } catch (error) {
        console.log(`[serial] Failed to open ${portPath}: ${error.message}`);
        abandon();
        throw error;
    }
    if (serialPort !== port) {
        // Torn down (disconnect/link loss) while open() was pending: releasePort() could not close a
        // handle that was not yet open, so close it now or the COM port stays locked.
        closePortQuietly(port);
        throw new Error('Port closed while opening');
    }

    console.log('[serial] Port open, requesting API version...');
    let version;
    try {
        version = await sendBinary(CMD.VERSION, Buffer.alloc(0), { handshake: true, timeout: HANDSHAKE_TIMEOUT_MS, retries: HANDSHAKE_RETRIES });
    } catch (error) {
        console.log(`[serial] Version read failed: ${error.message}`);
        abandon();
        throw error;
    }
    if (serialPort !== port) throw new Error('Port closed during handshake');
    if (!version.length || version[0] !== API_VERSION) {
        console.log(`[serial] Unsupported API version: ${version[0] ?? 'unknown'}`);
        abandon();
        throw new Error(`Unsupported controller API version: ${version[0] ?? 'unknown'}`);
    }

    // Only now is the link real: the UI never reports Connected for a port that has not answered.
    console.log(`[serial] Connected, API version ${version[0]}`);
    lastKnownPortPath = portPath;
    connectFailureStreak = 0;
    nextConnectAttemptAt = 0;
    lastRxOkAt = Date.now();
    watchdogGraceUntil = 0;
    state.connected = true;
    state.simulation = false;
    state.linkDegraded = false;
    state.port = portPath;
    publish();
    startWatchdog();
    // Whatever the controller was doing before this session (or before a link drop) is stale.
    await enterSafeState('system');
    return state;
}

// Fan off and motor back to zero angle, sent in the transport's own format
// (sendBinary picks the JSON/binary encoding for the verified API version).
// Never throws: it runs on startup and during shutdown where nothing can recover from it.
// `preempt` (shutdown) abandons whatever is queued or in flight so the fan-off is written
// immediately instead of waiting out a read that a silent controller will never answer.
async function enterSafeState(source = 'system', { preempt = false } = {}) {
    state.fanSpeed = 0;
    state.angle = 0;
    if (preempt && !state.simulation && isLinkUsable()) {
        linkGeneration += 1;
        rejectPending(new LinkError('Preempted by safe state'));
        commandQueue = Promise.resolve();
    }
    if (!state.simulation && isLinkUsable()) {
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
    const port = serialPort;
    serialPort = null;
    linkGeneration += 1;
    stopWatchdog();
    jsonBuffer = '';
    rejectPending(new LinkError('Disconnected'));
    commandQueue = Promise.resolve();
    releasePort(port);
    lastKnownPortPath = null;
    state.connected = false;
    state.port = null;
    state.linkDegraded = false;
    state.simulation = false;
    state.fanSpeed = 0;
    publish();
}

function startWatchdog() {
    stopWatchdog();
    watchdogTimer = setInterval(watchdogTick, WATCHDOG_INTERVAL_MS);
}

function stopWatchdog() {
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
}

function watchdogTick() {
    const port = serialPort;
    if (!state.connected || !port) return;
    if (!port.isOpen) { markLinkLost('port no longer open', port); return; }
    const now = Date.now();
    const silentFor = now - Math.max(lastRxOkAt, watchdogGraceUntil);
    if (silentFor >= LINK_LOST_MS) {
        markLinkLost(`no valid reply from the controller for ${Math.round(silentFor / 1000)}s`, port);
        return;
    }
    const degraded = silentFor >= LINK_DEGRADED_MS;
    if (degraded !== Boolean(state.linkDegraded)) { state.linkDegraded = degraded; publish(); }
    // The sensor timer is the normal source of replies; this keeps the link under test through
    // sweeps and idle gaps, and never competes with real work already in the queue.
    if (silentFor >= HEARTBEAT_AFTER_MS && now >= watchdogGraceUntil && queuedCommands === 0) {
        sendBinary(CMD.VERSION, Buffer.alloc(0), { source: 'system', retries: 0, timeout: HEARTBEAT_TIMEOUT_MS, audit: false }).catch(() => {});
    }
}

function requestRescan(delayMs) {
    if (!scanTimer) return; // auto-connect was never started (simulation / manual use)
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => { rescanTimer = null; scanOnce(); }, delayMs);
}

function isTargetPort(port) {
    return String(port.vendorId || '').toUpperCase() === '12BF' && String(port.productId || '').toUpperCase() === 'F010';
}

function findTargetPort(ports) {
    const matches = ports.filter(isTargetPort);
    // Windows may hand the controller a different COM number after a replug, so the VID/PID match
    // decides; the previous path is only a tie-break between several identical controllers.
    return matches.find((port) => port.path === lastKnownPortPath) || matches[0];
}

async function scanOnce() {
    if (scanBusy || connectInFlight || state.connected || state.simulation || !SerialPort) return;
    if (Date.now() < nextConnectAttemptAt) return;
    scanBusy = true;
    try {
        let ports = [];
        let listed = true;
        try { ports = await SerialPort.list(); }
        catch (error) { listed = false; console.log(`[serial] Port listing failed: ${error.message}`); }
        const signature = ports.map((p) => `${p.path}(${p.vendorId || '?'}:${p.productId || '?'})`).join(', ') || 'none';
        if (signature !== lastPortSignature) { lastPortSignature = signature; console.log(`[serial] Ports: ${signature}`); }
        if (state.connected || connectInFlight) return;
        let targetPath = findTargetPort(ports)?.path;
        // If the OS cannot enumerate right now, fall back to the last good path rather than idling.
        if (!targetPath && !listed) targetPath = lastKnownPortPath;
        if (!targetPath) return;
        console.log(`[serial] Target device found at ${targetPath}`);
        try { await connectHardware(targetPath, 115200); }
        catch (error) {
            console.log(`[serial] Connect attempt failed: ${error.message}`);
            state.diagnostics.errors += 1;
            connectFailureStreak += 1;
            nextConnectAttemptAt = Date.now() + Math.min(500 * 2 ** (connectFailureStreak - 1), MAX_CONNECT_BACKOFF_MS);
            publish();
        }
    } finally { scanBusy = false; }
}

function startAutoConnect() {
    if (!SerialPort) console.log('[serial] SerialPort module is not available; USB auto-connect disabled');
    if (scanTimer) return;
    scanTimer = setInterval(scanOnce, SCAN_INTERVAL_MS);
    scanOnce();
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
    onUnexpectedDisconnect
};
