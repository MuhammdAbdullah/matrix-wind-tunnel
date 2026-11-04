const { EventEmitter } = require('events');
const WebSocket = require('ws');

const DEFAULT_ETHERNET_PORT = 1245;
// The controller services the W5500 from its main loop. Sensor work and the legacy socket's
// recovery path can delay the HTTP upgrade for several seconds, so four seconds was too short on
// real hardware and turned a slow-but-valid connection into an avoidable reconnect storm.
const CONNECT_TIMEOUT_MS = 8000;
// A controller without the access-control firmware never answers "Hi": treat silence as legacy firmware.
const LEGACY_WAIT_MS = 1500;
// From sending "Hi" to "OK"; the controller drops an unverified client after ~5-10 s itself.
const AUTH_BUDGET_MS = 6000;

// The handshake the controller expects from a Wind Tunnel app (docs/ethernet-access-control.md):
// app "Hi" -> controller "Hey", app "COM" -> controller "OK". Anything else and the controller drops the link.
const HI = '{"hi":1}';
const COMMS_DEBUG = process.env.WIND_TUNNEL_SERIAL_DEBUG === '1';
const traceHandshake = (direction, text) => { if (COMMS_DEBUG) console.log(`[comms ${new Date().toISOString().slice(11, 23)}] ${direction} ethernet-handshake ${JSON.stringify(text)}`); };
const COM = '{"com":1}';

// {"auth":n} terminal replies from the controller. The controller closes the socket after sending one of these.
const AUTH_ERRORS = {
    0: ['AUTH_FAILED', 'The controller did not accept the connection (it may still be closing the previous session). The app retries automatically; if it keeps failing, read the IP address on the controller touchscreen.'],
    2: ['USB_IN_CONTROL', 'The controller is under USB control, so network connections are refused.'],
    4: ['AUTH_TIMEOUT', 'The controller timed out waiting for the handshake.']
};

function authError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.isAuth = true;
    return error;
}

// A close handshake is always attempted first: an abrupt drop wedges the controller's single Ethernet
// socket for ~23 s. A socket that never opened is torn down. Calls back once, whatever happens.
function closeSocketPolitely(socket, callback = () => {}) {
    if (!socket) { callback(); return; }
    let called = false;
    const finish = () => { if (called) return; called = true; callback(); };
    try {
        if (socket.readyState === WebSocket.OPEN) {
            socket.once('close', finish);
            socket.close();
            // A half-open TCP peer never completes the close handshake; do not wait for it.
            const timer = setTimeout(() => { try { socket.terminate(); } catch (_error) { /* already gone */ } finish(); }, 1000);
            if (timer.unref) timer.unref();
        } else if (socket.readyState === WebSocket.CONNECTING) {
            socket.terminate();
            finish();
        } else finish();
    } catch (_error) { finish(); }
}

// Handshake frames are flat objects: {"hey":1} / {"ok":1} while the handshake runs, {"auth":n} at any time
// (no normal API reply has an "auth" key, and "hey"/"ok" are only looked for during the handshake).
function parseControlFrame(buffer, handshaking) {
    const text = buffer.toString('utf8');
    if (!text.includes('"auth"') && !(handshaking && (text.includes('"hey"') || text.includes('"ok"')))) return null;
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && ('auth' in parsed || (handshaking && ('hey' in parsed || 'ok' in parsed)))) return parsed;
    } catch (_error) { /* not a control frame */ }
    return null;
}

// V2.0.7 firmware serves its JSON API over a WebSocket (WebSocket1 on EthPort, default 1245): each
// request is one text message and each reply (SendText) is one text message. This class gives that
// socket the small slice of the SerialPort interface that serial.js uses (open/write/close/isOpen/
// 'data'/'error'/'close'), so the shared command queue, retry logic and watchdog run unchanged over
// Ethernet.
//
// Access control: right after connecting we send {"hi":1}; the controller answers {"hey":1}, we send {"com":1}
// and it answers {"ok":1}. open() only reports success once that completes (or, for a controller that never
// answers, after LEGACY_WAIT_MS). Handshake frames never reach 'data'. A late {"auth":n} after open (e.g. USB
// takes over) is handled the same way: auth failures are emitted as an 'error' with .code/.isAuth set.
class EthernetPort extends EventEmitter {
    constructor({ host, port = DEFAULT_ETHERNET_PORT, connectTimeout = CONNECT_TIMEOUT_MS }) {
        super();
        this.host = host;
        this.port = port;
        this.path = `ws://${host}:${port}`;
        this.connectTimeout = connectTimeout;
        this.socket = null;
        this.isOpen = false;
        this.authenticated = false;
        this.timers = [];
    }

    clearTimers() {
        this.timers.forEach(clearTimeout);
        this.timers = [];
    }

    open(callback) {
        let settled = false;
        const done = (error) => { if (settled) return; settled = true; callback(error); };
        let socket;
        try {
            socket = new WebSocket(this.path, { handshakeTimeout: this.connectTimeout, perMessageDeflate: false, maxPayload: 64 * 1024 });
        } catch (error) { done(error); return; }
        this.socket = socket;
        // 'hi' (sent Hi, Hey expected) -> 'com' (sent COM, OK expected) -> 'done'. 'legacy' = opened without any Hey.
        let phase = 'hi';

        const fail = (error) => {
            this.clearTimers();
            if (this.socket !== socket) return;
            this.isOpen = false;
            this.socket = null;
            // Close before reporting: serial.js cannot close a port whose isOpen is still false.
            closeSocketPolitely(socket);
            if (!settled) done(error); else this.emit('error', error);
        };
        const succeed = () => {
            this.clearTimers();
            phase = 'done';
            this.authenticated = true;
            this.isOpen = true;
            done();
        };
        const send = (text) => traceHandshake('TX', text) || socket.send(text, (error) => { if (error) fail(authError('AUTH_FAILED', `Could not send the handshake: ${error.message}`)); });
        const openedAt = Date.now();
        const onControl = (frame) => {
            if ('auth' in frame) {
                // Where the controller refused matters for diagnosing it: phase 'hi' with a tiny delay means it refused before
                // our Hi could have been processed (it had no client state for us); phase 'com' means it refused the second step.
                console.log(`[ethernet] controller sent auth:${frame.auth} in phase '${phase}', ${Date.now() - openedAt} ms after the WebSocket opened`);
                const [errorCode, text] = AUTH_ERRORS[Number(frame.auth)] || ['AUTH_FAILED', `The controller refused the connection (auth ${frame.auth}).`];
                fail(authError(errorCode, text));
                return;
            }
            if ('hey' in frame && (phase === 'hi' || phase === 'legacy')) {
                this.clearTimers();
                this.timers.push(setTimeout(() => fail(authError('AUTH_TIMEOUT', 'The handshake with the controller did not complete in time.')), AUTH_BUDGET_MS));
                phase = 'com';
                send(COM);
            } else if ('ok' in frame && phase === 'com') succeed();
        };

        socket.on('open', () => {
            send(HI);
            this.timers.push(setTimeout(() => {
                if (phase !== 'hi' || this.socket !== socket) return;
                phase = 'legacy';
                this.isOpen = true;
                done();
            }, LEGACY_WAIT_MS));
        });
        socket.on('message', (data) => {
            if (this.socket !== socket) return;
            const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
            const frame = parseControlFrame(buffer, phase === 'hi' || phase === 'com' || phase === 'legacy');
            if (frame) { traceHandshake('RX', buffer.toString('utf8')); onControl(frame); return; }
            if (this.isOpen) this.emit('data', buffer);
        });
        socket.on('error', (error) => {
            if (!settled) { this.clearTimers(); done(error); return; }
            if (this.socket === socket) this.emit('error', error);
        });
        socket.on('close', () => {
            this.clearTimers();
            const wasOpen = this.isOpen;
            if (this.socket === socket) { this.isOpen = false; this.socket = null; }
            if (!settled) { done(new Error(`Could not open ${this.path}`)); return; }
            if (wasOpen) this.emit('close', { disconnected: true });
        });
    }

    write(buffer, callback) {
        if (!this.isOpen || !this.socket) { callback(new Error('Ethernet link is not open')); return; }
        this.socket.send(buffer.toString('utf8'), (error) => callback(error || null));
    }

    close(callback = () => {}) {
        const socket = this.socket;
        this.clearTimers();
        this.isOpen = false;
        this.socket = null;
        if (!socket) { callback(); return; }
        socket.removeAllListeners('message');
        // Always a proper close handshake first -- see closeSocketPolitely().
        closeSocketPolitely(socket, callback);
    }
}

const LOCKED_STATUS = {
    USB_IN_CONTROL: 'usb-in-control',
    AUTH_FAILED: 'refused',
    AUTH_TIMEOUT: 'timeout'
};

// One-shot reachability probe used by the network scan: opens ws://host:port (running the Hi/COM handshake) and asks for the API version. Resolves the version number,
// { locked: <status> } when a controller answered but would not let this PC in (USB in control, refused...), or null when nothing (or something else) answers. `timeoutMs` bounds the TCP/WebSocket
// connect; the handshake and the version reply have their own budgets once something is listening.
function probe(host, port = DEFAULT_ETHERNET_PORT, timeoutMs = 1200) {
    return new Promise((resolve) => {
        let finished = false;
        let replyTimer = null;
        const probePort = new EthernetPort({ host, port, connectTimeout: timeoutMs });
        const finish = (value) => {
            if (finished) return;
            finished = true;
            clearTimeout(replyTimer);
            probePort.removeAllListeners('data');
            probePort.on('error', () => {});
            probePort.close();
            resolve(value);
        };
        const lockedFrom = (error) => (error && error.isAuth ? { locked: LOCKED_STATUS[error.code] || 'rejected' } : null);
        probePort.open((error) => {
            if (error) { finish(lockedFrom(error)); return; }
            replyTimer = setTimeout(() => finish(null), 1500);
            probePort.on('data', (chunk) => {
                try {
                    const reply = JSON.parse(chunk.toString('utf8'));
                    if (Number.isFinite(Number(reply.version))) finish(Number(reply.version));
                } catch (_error) { /* keep waiting for a parsable reply until the timer fires */ }
            });
            probePort.on('error', (portError) => finish(lockedFrom(portError)));
            probePort.on('close', () => finish(null));
            probePort.write(Buffer.from('{"version":0}'), (writeError) => { if (writeError) finish(null); });
        });
    });
}

module.exports = { EthernetPort, probe, DEFAULT_ETHERNET_PORT, closeSocketPolitely };
