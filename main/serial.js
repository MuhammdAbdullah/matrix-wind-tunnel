const { CMD } = require('./protocol');
const { state, publish, clamp, simulateSensors, appendAudit, API_VERSION } = require('./state');
const { EthernetPort, DEFAULT_ETHERNET_PORT } = require('./ethernet');
const { pingOnce } = require('./reach');

let SerialPort;
try { ({ SerialPort } = require('serialport')); } catch (error) { console.log(`[serial] Failed to load 'serialport' module: ${error.message}`); SerialPort = null; }

const USB_VENDOR_ID = 0x12BF;
const USB_PRODUCT_ID = 0xF010;
const SCAN_INTERVAL_MS = 2000;
const RESCAN_AFTER_LOSS_MS = 500;
const MAX_CONNECT_BACKOFF_MS = 4000;
// The controller has one W5500 socket. The "Socket fix / B-nousb" firmware (EthPoll) drops a vanished
// client within ~5-10 s (WebSocket PingIdle 25), refuses a connection while it holds a stale session
// instead of wedging, and no longer re-runs DHCP after a failed client, so a retry costs the controller
// nothing. The old 10-25 s quiet periods (written for the legacy socket, which stayed wedged for ~23 s)
// only made a cable unplug/replug feel much longer than it is: keep the waits short.
// After an established Ethernet session is lost (the app notices after LINK_LOST_MS, so the cable has
// usually been back a while by then):
const ETHERNET_LINK_RECOVERY_MS = 500;
// Failed attempts back off from this, doubling up to the cap, until one succeeds:
const ETHERNET_RETRY_BASE_MS = 1000;
const ETHERNET_RETRY_MAX_MS = 5000;
// Ethernet refused by the controller's access control (it did not accept this connection, e.g. it was
// still closing the previous session). Only a floor under the retry delay above.
const ETHERNET_BLOCKED_BACKOFF_MS = 3000;
// Ping-assisted link tracking (see reachTick). USB reports an unplug at once; a network cable gives no signal,
// so without this an Ethernet drop is only noticed after LINK_LOST_MS and a reconnect attempt to a controller
// that is still unreachable hangs for the whole connect timeout before the next one can start.
const REACH_INTERVAL_MS = 700;
const REACH_PING_MS = 600;
// While connected, only ping once the API has been silent this long; two failed pings then end the link.
const REACH_SILENT_MS = 2000;
// While the controller does not answer ping, skip connect attempts, but still try this often in case ICMP is filtered.
const REACH_GATE_MAX_MS = 10000;
const ETHERNET_BLOCKED_CODES = new Set(['USB_IN_CONTROL', 'AUTH_FAILED']);
const OPEN_TIMEOUT_MS = 5000;
// EthernetPort.open() includes both the HTTP upgrade and the controller access handshake. Keep the
// outer timeout above both budgets; otherwise serial.js can abandon a socket that is still making
// legitimate progress.
const ETHERNET_OPEN_TIMEOUT_MS = 15000;
const CLOSE_TIMEOUT_MS = 3000;
const MAX_FRAME_RETRIES = 2;
const MAX_JSON_BUFFER = 2048;
// The controller's API only comes up ~3-4 s after the COM port appears (splash screen + sensor
// warm-up), so the connect handshake is far more patient than steady-state commands.
const HANDSHAKE_TIMEOUT_MS = 1500;
const HANDSHAKE_RETRIES = 5;
// Link watchdog: apart from touchscreen change reports the firmware sends nothing unsolicited, so
// liveness is "time since the last valid reply". The lost threshold sits above the firmware's worst legitimate service gap (a held touch
// blocks the API for up to ~5 s).
const WATCHDOG_INTERVAL_MS = 500;
const HEARTBEAT_AFTER_MS = 1500;
const HEARTBEAT_TIMEOUT_MS = 1500;
const LINK_DEGRADED_MS = 3000;
const LINK_LOST_MS = 8000;
// Commands after which the firmware can legitimately stay silent for a while (EEPROM writes, W5500
// re-init). The watchdog treats the grace window as "recent activity".
const WATCHDOG_GRACE_MS = {
    [CMD.SET_NETWORK]: 10000,
    [CMD.SET_MAC]: 3000,
    [CMD.SET_SCALER]: 3000,
    [CMD.SET_LUT]: 3000,
    [CMD.GET_LUT]: 3000
};
const SERIAL_DEBUG = process.env.WIND_TUNNEL_SERIAL_DEBUG === '1';
// WIND_TUNNEL_SERIAL_DEBUG=1: one timestamped line per message sent/received on the active link (USB or Ethernet),
// plus the Ethernet handshake frames (ethernet.js). Printed to the terminal that launched the app.
function trace(direction, buffer) {
    if (!SERIAL_DEBUG) return;
    const stamp = new Date().toISOString().slice(11, 23);
    console.log(`[comms ${stamp}] ${direction} ${state.transport || 'link'} ${JSON.stringify(buffer.toString('utf8'))}`);
}
const RESPONSE_COMMANDS = new Set([CMD.VERSION, CMD.READ_SENSORS, CMD.GET_SCALERS, CMD.GET_LUT, CMD.NETINFO, CMD.MACINFO]);
const LUT_KEYS = Array.from({ length: 10 }, (_unused, index) => `vl${index}`);
// A reply object only resolves the pending command if it carries every one of that command's keys as
// a finite number; anything else (e.g. the late second half of a getvlu reply after a retry, or a
// partial reading) is a stray and is ignored so it can never overwrite valid data.
const RESPONSE_KEYS = {
    [CMD.VERSION]: ['version'],
    [CMD.READ_SENSORS]: ['lift', 'drag', 'pressure', 'velocity'],
    [CMD.GET_SCALERS]: ['sl', 'sd', 'sp'],
    [CMD.NETINFO]: ['port', 'dhcp']
};
// Keys whose reply values are non-empty strings (addresses). Checked in addition to RESPONSE_KEYS, which
// stays strictly numeric for every other key.
const RESPONSE_STRING_KEYS = {
    [CMD.NETINFO]: ['ip'],
    [CMD.MACINFO]: ['mac', 'sip']
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

// Set by main/network.js from the saved Admin settings. USB always wins: this is only a fallback used
// while no USB controller is present.
// Ping tracking. reachSeenFor = the host that has answered a ping at least once: only then does a failed ping
// mean anything (ICMP may be filtered on some networks, and then ping must never end a working link).
let reachSeenFor = '';
let controllerReachable = true;
let reachFailures = 0;
let reachBusy = false;
let reachTimer = null;
let lastEthernetAttemptAt = 0;
let ethernetTarget = { enabled: false, host: '', port: DEFAULT_ETHERNET_PORT };

// Set by main/network.js while another PC announces that it owns the controller over USB: the USB master
// wins, so this app lets go of (and does not retry) its Ethernet link. null = not yielding.
let ethernetYieldReason = null;

function setEthernetYield(reason) {
    if (reason === ethernetYieldReason) return;
    ethernetYieldReason = reason;
    if (!reason) requestRescan(100);
}

function setEthernetTarget(target) {
    if (String(target.host || '').trim() !== ethernetTarget.host) { reachSeenFor = ''; controllerReachable = true; reachFailures = 0; }
    ethernetTarget = { enabled: Boolean(target.enabled), host: String(target.host || '').trim(), port: Number(target.port) || DEFAULT_ETHERNET_PORT };
    requestRescan(100);
}

const disconnectListeners = [];

function onUnexpectedDisconnect(listener) {
    disconnectListeners.push(listener);
}

function notifyUnexpectedDisconnect(reason) {
    disconnectListeners.forEach((listener) => {
        try { listener(reason); } catch (_error) { /* listener errors must not break reconnect flow */ }
    });
}

const connectedListeners = [];

// Called (never throws into the connect flow) once a session is verified and live; main/netinfo.js uses it
// to read the controller's network identity.
function onConnected(listener) {
    connectedListeners.push(listener);
}

function notifyConnected() {
    connectedListeners.forEach((listener) => {
        try { listener(state.transport); } catch (_error) { /* listener errors must not break the connect flow */ }
    });
}

// The controller's access control refused this PC (USB in control, or it did not accept the connection). Shown in Admin > Network.
function noteEthernetBlocked(error) {
    if (!error || !error.isAuth) return false;
    state.network.ethernetBlocked = { code: error.code, message: error.message, at: new Date().toISOString() };
    if (ETHERNET_BLOCKED_CODES.has(error.code)) nextConnectAttemptAt = Date.now() + ETHERNET_BLOCKED_BACKOFF_MS;
    publish();
    return true;
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
        // V2.0.7 added the dhcp flag (WindTunnelAPI 1.xlsx). It is always sent: the firmware only applies the
        // address to the W5500 and re-creates the WebSocket server when `dhcp` is present, and it sends no reply.
        case CMD.SET_NETWORK: {
            const request = { ip0: payload[0], ip1: payload[1], ip2: payload[2], ip3: payload[3], port: payload.readUInt16LE(4) };
            request.dhcp = payload.length > 6 ? payload[6] : 0;
            return request;
        }
        // The MAC must travel in its own frame, sent before SET_NETWORK: the firmware reads a request into a 100-byte
        // buffer (FCM_ParseJSON), and ip0-ip3 + port + mac0-mac5 + dhcp is up to 124 characters, so a combined frame is
        // cut off before mac4/mac5/dhcp and the MAC is silently ignored. This frame is ~62 characters. The firmware
        // stores it in EEPROM at once and applies it to the W5500 when the next SET_NETWORK (dhcp) arrives.
        case CMD.SET_MAC: {
            const request = {};
            for (let index = 0; index < 6; index += 1) request[`mac${index}`] = payload[index];
            return request;
        }
        case CMD.NETINFO: return { netinfo: 0 };
        case CMD.MACINFO: return { macinfo: 0 };
        // Same trigger Process Control V2 sends ({"BL":1}); the controller resets into its USB HID
        // bootloader and does not reply, so this command is never in RESPONSE_COMMANDS.
        case CMD.ENTER_BOOTLOADER: return { BL: 1 };
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
    // Address/identity replies carry strings, so they are handed on as the reply object's JSON text.
    if (command === CMD.NETINFO) return Buffer.from(JSON.stringify({ ip: response.ip, port: Number(response.port), dhcp: Number(response.dhcp) }));
    if (command === CMD.MACINFO) return Buffer.from(JSON.stringify({ mac: response.mac, sip: response.sip }));
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
        trace('TX', packet);
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

// V2.0.7+ reports changes made on its own touchscreen as unsolicited flat objects that reuse the set
// command keys: {"fanspeed":n}, {"angle":n}, {"animmode":m,"animr":r,"animg":g,"animb":b} and the same
// with the amb* keys. No reply object carries any of these keys, so they can never be mistaken for one.
const TOUCH_UPDATE_KEYS = ['fanspeed', 'angle', 'animmode', 'ambmode'];

function finiteField(message, key) {
    const raw = message[key];
    if (raw === null || raw === '' || typeof raw === 'boolean') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

function applyTouchUpdate(message) {
    if (!TOUCH_UPDATE_KEYS.some((key) => key in message)) return false;
    const fanSpeed = finiteField(message, 'fanspeed');
    if (fanSpeed !== null) state.fanSpeed = Math.round(clamp(fanSpeed, 0, 100));
    const angle = finiteField(message, 'angle');
    if (angle !== null) state.angle = Math.round(clamp(angle, -180, 180));
    const channel = (prefix, color) => ({
        r: Math.round(clamp(finiteField(message, `${prefix}r`) ?? color.r, 0, 255)),
        g: Math.round(clamp(finiteField(message, `${prefix}g`) ?? color.g, 0, 255)),
        b: Math.round(clamp(finiteField(message, `${prefix}b`) ?? color.b, 0, 255))
    });
    const animMode = finiteField(message, 'animmode');
    if (animMode !== null) {
        state.leds.animMode = Math.round(clamp(animMode, 0, 4));
        state.leds.animColor = channel('anim', state.leds.animColor);
    }
    const ambMode = finiteField(message, 'ambmode');
    if (ambMode !== null) {
        state.leds.ambMode = Math.round(clamp(ambMode, 0, 3));
        state.leds.ambColor = channel('amb', state.leds.ambColor);
    }
    publish();
    return true;
}

function handleData(chunk) {
    record('rx', chunk);
    trace('RX', chunk);
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
        // A touchscreen change is not the reply to anything, so it must never resolve the pending command.
        if (applyTouchUpdate(response)) continue;
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
        } else if ((RESPONSE_KEYS[request.command] && !RESPONSE_KEYS[request.command].every((key) => Number.isFinite(Number(response[key])) && response[key] !== null && response[key] !== ''))
            || (RESPONSE_STRING_KEYS[request.command] && !RESPONSE_STRING_KEYS[request.command].every((key) => typeof response[key] === 'string' && response[key].length > 0))) {
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
function openPort(port, timeoutMs = OPEN_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; reject(new Error(`Timed out opening ${port.path}`)); }, timeoutMs);
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
    const lostTransport = state.transport;
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
    state.transport = null;
    state.linkDegraded = false;
    state.network.controller = null;
    publish();
    if (wasConnected) notifyUnexpectedDisconnect(reason);
    if (lostTransport === 'ethernet') {
        console.log(`[serial] Ethernet socket recovery: waiting ${ETHERNET_LINK_RECOVERY_MS / 1000}s before reconnecting`);
        nextConnectAttemptAt = Math.max(nextConnectAttemptAt, Date.now() + ETHERNET_LINK_RECOVERY_MS);
        requestRescan(ETHERNET_LINK_RECOVERY_MS);
    } else {
        requestRescan(RESCAN_AFTER_LOSS_MS);
    }
}

function bindPort(port) {
    port.on('data', (chunk) => { if (port === serialPort) handleData(chunk); });
    port.on('error', (error) => {
        console.log(`[serial] Port error: ${error.message}`);
        if (port !== serialPort) return;
        state.diagnostics.errors += 1;
        noteEthernetBlocked(error);
        // An error on the active port means the stream is unusable (serialport destroys it).
        markLinkLost(`port error: ${error.message}`, port);
    });
    port.on('end', () => markLinkLost('port stream ended', port));
    port.on('close', (error) => markLinkLost(error?.disconnected ? 'device disconnected' : 'port closed', port));
}

function connectHardware(portPath, baudRate = 115200) {
    return connectTarget({ transport: 'usb', path: portPath, baudRate });
}

function connectEthernet(host, port = DEFAULT_ETHERNET_PORT) {
    return connectTarget({ transport: 'ethernet', host, port });
}

function createPort(target) {
    if (target.transport === 'ethernet') return new EthernetPort({ host: target.host, port: target.port });
    return new SerialPort({ path: target.path, baudRate: target.baudRate, autoOpen: false, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false, dtr: true, rts: true });
}

async function connectTarget(target) {
    if (target.transport !== 'ethernet' && !SerialPort) throw new Error('SerialPort dependency is not installed');
    if (connectInFlight) throw new Error('A connection attempt is already in progress');
    connectInFlight = true;
    state.connecting = true;
    publish();
    try {
        return await openSession(target);
    } finally {
        connectInFlight = false;
        state.connecting = false;
        publish();
    }
}

async function openSession(target) {
    const portPath = target.transport === 'ethernet' ? `ws://${target.host}:${target.port}` : target.path;
    console.log(`[serial] Opening ${portPath} (${target.transport})...`);
    if (serialPort) markLinkLost('replaced by a new connection', serialPort);
    stopWatchdog();
    linkGeneration += 1;
    const port = createPort(target);
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
        await openPort(port, target.transport === 'ethernet' ? ETHERNET_OPEN_TIMEOUT_MS : OPEN_TIMEOUT_MS);
    } catch (error) {
        console.log(`[serial] Failed to open ${portPath}: ${error.message}`);
        noteEthernetBlocked(error);
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
    if (target.transport === 'usb') lastKnownPortPath = portPath;
    connectFailureStreak = 0;
    nextConnectAttemptAt = 0;
    lastRxOkAt = Date.now();
    watchdogGraceUntil = 0;
    state.connected = true;
    state.simulation = false;
    state.linkDegraded = false;
    state.port = portPath;
    state.transport = target.transport;
    if (target.transport === 'ethernet') {
        state.network.ethernetBlocked = null;
        pingOnce(target.host, REACH_PING_MS).then((ok) => { if (ok && ethernetTarget.host === target.host) { reachSeenFor = target.host; controllerReachable = true; } });
    }
    publish();
    startWatchdog();
    // Whatever the controller was doing before this session (or before a link drop) is stale.
    await enterSafeState('system');
    notifyConnected();
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
    state.transport = null;
    state.linkDegraded = false;
    state.simulation = false;
    state.fanSpeed = 0;
    state.network.controller = null;
    publish();
}

// Shutdown path: releases the link and waits for the close to complete. For Ethernet this matters --
// exiting with the WebSocket still open makes the controller refuse new connections for ~23 s.
async function closeLink() {
    const port = serialPort;
    serialPort = null;
    linkGeneration += 1;
    stopWatchdog();
    jsonBuffer = '';
    rejectPending(new LinkError('Application closing'));
    commandQueue = Promise.resolve();
    if (port) port.removeAllListeners('data');
    await closePortQuietly(port);
    state.connected = false;
    state.port = null;
    state.transport = null;
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
    if (scanBusy || connectInFlight || state.simulation || state.transport === 'remote') return;
    // An Ethernet session is only a stand-in for USB, so keep looking for the USB controller while on it.
    const onEthernet = state.connected && state.transport === 'ethernet';
    if (state.connected && !onEthernet) return;
    if (onEthernet && ethernetYieldReason) { markLinkLost(ethernetYieldReason, serialPort); return; }
    if (!SerialPort && !ethernetTarget.enabled) return;
    if (!onEthernet && Date.now() < nextConnectAttemptAt) return;
    scanBusy = true;
    try {
        let ports = [];
        let listed = true;
        try { ports = SerialPort ? await SerialPort.list() : []; }
        catch (error) { listed = false; console.log(`[serial] Port listing failed: ${error.message}`); }
        const signature = ports.map((p) => `${p.path}(${p.vendorId || '?'}:${p.productId || '?'})`).join(', ') || 'none';
        if (signature !== lastPortSignature) { lastPortSignature = signature; console.log(`[serial] Ports: ${signature}`); }
        if (connectInFlight) return;
        let targetPath = findTargetPort(ports)?.path;
        // If the OS cannot enumerate right now, fall back to the last good path rather than idling.
        if (!targetPath && !listed) targetPath = lastKnownPortPath;
        if (onEthernet) {
            if (!targetPath) return;
            // USB is the master link: hand the controller over from Ethernet. Listeners stop any sweep.
            markLinkLost('USB controller detected; USB takes priority over Ethernet', serialPort);
        } else if (state.connected) return;
        if (!targetPath) {
            if (!ethernetTarget.enabled || !ethernetTarget.host || ethernetYieldReason) return;
            if (reachSeenFor === ethernetTarget.host && !controllerReachable && Date.now() - lastEthernetAttemptAt < REACH_GATE_MAX_MS) return;
            lastEthernetAttemptAt = Date.now();
            console.log(`[serial] No USB controller; trying Ethernet ${ethernetTarget.host}:${ethernetTarget.port}`);
            try { await connectEthernet(ethernetTarget.host, ethernetTarget.port); }
            catch (error) {
                console.log(`[serial] Ethernet connect failed: ${error.message}`);
                connectFailureStreak += 1;
                const backoffUntil = Date.now() + Math.min(ETHERNET_RETRY_BASE_MS * 2 ** (connectFailureStreak - 1), ETHERNET_RETRY_MAX_MS);
                nextConnectAttemptAt = ETHERNET_BLOCKED_CODES.has(error.code) ? Math.max(backoffUntil, nextConnectAttemptAt) : backoffUntil;
                publish();
            }
            return;
        }
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

async function reachTick() {
    if (reachBusy || state.simulation || state.transport === 'remote' || state.transport === 'usb') return;
    const { enabled, host } = ethernetTarget;
    if (!enabled || !host) return;
    const onEthernet = state.connected && state.transport === 'ethernet';
    if (onEthernet && Date.now() - Math.max(lastRxOkAt, watchdogGraceUntil) < REACH_SILENT_MS) { reachFailures = 0; return; }
    reachBusy = true;
    const port = serialPort;
    try {
        if (await pingOnce(host, REACH_PING_MS)) {
            reachSeenFor = host;
            reachFailures = 0;
            if (!controllerReachable) {
                controllerReachable = true;
                console.log('[serial] Controller answers ping again: reconnecting now');
                nextConnectAttemptAt = 0;
                connectFailureStreak = 0;
                requestRescan(0);
            }
            return;
        }
        reachFailures += 1;
        if (reachSeenFor !== host || reachFailures < 2) return;
        if (controllerReachable) console.log('[serial] Controller no longer answers ping (cable unplugged or network down)');
        controllerReachable = false;
        if (onEthernet && serialPort === port && state.transport === 'ethernet') markLinkLost('the controller stopped answering on the network (cable unplugged?)', port);
    } finally { reachBusy = false; }
}

function startAutoConnect() {
    if (!SerialPort) console.log('[serial] SerialPort module is not available; USB auto-connect disabled');
    if (scanTimer) return;
    scanTimer = setInterval(scanOnce, SCAN_INTERVAL_MS);
    reachTimer = setInterval(reachTick, REACH_INTERVAL_MS);
    if (reachTimer.unref) reachTimer.unref();
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
    connectEthernet,
    setEthernetTarget,
    setEthernetYield,
    disconnect,
    closeLink,
    startAutoConnect,
    listPorts,
    setFanSpeed,
    setAngle,
    setLeds,
    enterSafeState,
    readSensorsOnce,
    onUnexpectedDisconnect,
    onConnected
};
