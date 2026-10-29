const { EventEmitter } = require('events');
const WebSocket = require('ws');

const DEFAULT_ETHERNET_PORT = 1245;
const CONNECT_TIMEOUT_MS = 4000;

// V2.0.7 firmware serves its JSON API over a WebSocket (WebSocket1 on EthPort, default 1245): each
// request is one text message and each reply (SendText) is one text message. This class gives that
// socket the small slice of the SerialPort interface that serial.js uses (open/write/close/isOpen/
// 'data'/'error'/'close'), so the shared command queue, retry logic and watchdog run unchanged over
// Ethernet.
class EthernetPort extends EventEmitter {
    constructor({ host, port = DEFAULT_ETHERNET_PORT }) {
        super();
        this.host = host;
        this.port = port;
        this.path = `ws://${host}:${port}`;
        this.socket = null;
        this.isOpen = false;
    }

    open(callback) {
        let settled = false;
        const done = (error) => { if (settled) return; settled = true; callback(error); };
        let socket;
        try {
            socket = new WebSocket(this.path, { handshakeTimeout: CONNECT_TIMEOUT_MS, perMessageDeflate: false, maxPayload: 64 * 1024 });
        } catch (error) { done(error); return; }
        this.socket = socket;
        socket.on('open', () => { this.isOpen = true; done(); });
        socket.on('message', (data) => { if (this.socket === socket) this.emit('data', Buffer.isBuffer(data) ? data : Buffer.from(data)); });
        socket.on('error', (error) => {
            if (!settled) { done(error); return; }
            if (this.socket === socket) this.emit('error', error);
        });
        socket.on('close', () => {
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
        this.isOpen = false;
        this.socket = null;
        if (!socket) { callback(); return; }
        socket.removeAllListeners('message');
        // Always a proper close handshake first -- see the note in probe(): an abrupt drop wedges the
        // controller's single Ethernet socket for ~23 s.
        socket.once('close', () => callback());
        try { socket.close(); } catch (_error) { callback(); return; }
        // A half-open TCP peer never completes the close handshake; do not wait for it.
        setTimeout(() => { try { socket.terminate(); } catch (_error) { /* already gone */ } }, 1000);
    }
}

// One-shot reachability probe used by the network scan: opens ws://host:port and asks for the API
// version. Resolves the version number, or null when nothing (or something else) answers.
function probe(host, port = DEFAULT_ETHERNET_PORT, timeoutMs = 1200) {
    return new Promise((resolve) => {
        let finished = false;
        let socket = null;
        const finish = (value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            // Verified on hardware: a client that vanishes without the WebSocket close handshake leaves
            // the controller refusing every connection for ~23 s, so close politely whenever the
            // socket is actually open. Only a socket that never opened is torn down.
            if (socket) {
                try {
                    if (socket.readyState === WebSocket.OPEN) { socket.close(); setTimeout(() => { try { socket.terminate(); } catch (_error) { /* already gone */ } }, 1000); }
                    else socket.terminate();
                } catch (_error) { /* already gone */ }
            }
            resolve(value);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        try {
            socket = new WebSocket(`ws://${host}:${port}`, { handshakeTimeout: timeoutMs, perMessageDeflate: false });
        } catch (_error) { finish(null); return; }
        socket.on('open', () => { try { socket.send('{"version":0}'); } catch (_error) { finish(null); } });
        socket.on('message', (data) => {
            try {
                const reply = JSON.parse(data.toString('utf8'));
                finish(Number.isFinite(Number(reply.version)) ? Number(reply.version) : null);
            } catch (_error) { /* keep waiting for a parsable reply until the timer fires */ }
        });
        socket.on('error', () => finish(null));
        socket.on('close', () => finish(null));
    });
}

module.exports = { EthernetPort, probe, DEFAULT_ETHERNET_PORT };
