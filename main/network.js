const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const dgram = require('dgram');
const WebSocket = require('ws');

const { state, publish, onPublish, appendAudit } = require('./state');
const { readConfig, updateConfig } = require('./config');
const { probe, DEFAULT_ETHERNET_PORT } = require('./ethernet');
const serial = require('./serial');
const sweeps = require('./sweeps');
const control = require('./control');

// ---------------------------------------------------------------------------------------------
// What this module does
//   1. Persists the Admin network settings (controller Ethernet target, relay policy).
//   2. Relay ("master"): the copy of the app that owns the hardware link (USB, or Ethernet when no
//      USB controller is present) can host a small WebSocket + web-page server. Other devices connect
//      to it instead of the controller. Admin decides whether they may only watch ('view') or also
//      send commands ('control'). The controller's firmware has no notion of clients or permissions,
//      so this is the only place the rule can be enforced.
//   3. Remote client: this copy of the app connects to another app's relay instead of hardware and
//      mirrors its state; control commands are forwarded to the master.
// ---------------------------------------------------------------------------------------------

const RELAY_DEFAULT_PORT = 8090;
const RELAY_MODES = ['off', 'view', 'control'];
const HELLO_TIMEOUT_MS = 5000;
const BROADCAST_MIN_INTERVAL_MS = 100;
const KEEPALIVE_MS = 15000;
const MAX_CLIENTS = 8;
const MAX_MESSAGE_BYTES = 4096;
const MAX_COMMANDS_PER_SECOND = 20;
const AUTH_MAX_FAILURES = 5;
const AUTH_LOCKOUT_MS = 60000;
const REMOTE_RECONNECT_MS = 3000;
const COMMAND_TIMEOUT_MS = 8000;
// No 0/O/1/I: the code is read off one screen and typed on another.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const WEB_FILES = { '/': ['remote/index.html', 'text/html; charset=utf-8'], '/remote.js': ['remote/remote.js', 'text/javascript; charset=utf-8'] };

// The only commands a relay client may send, each mapped to the shared control module. Everything
// else -- sweeps, logging, calibration, firmware, Admin -- stays on the master PC.
const RELAY_COMMANDS = {
    setFanSpeed: (args) => control.setFanSpeed(args[0], 'remote'),
    setAngle: (args) => control.setAngle(args[0], 'remote'),
    setLeds: (args) => control.setLeds(args[0] || {}, 'remote'),
    zeroSensors: () => control.zeroSensors('remote'),
    zeroMotor: () => control.zeroMotor('remote'),
    // Always allowed for a controller: stopping is the safe direction.
    stopSweep: async () => { sweeps.stopSweep(); return { ok: true }; }
};
// Commands that move the fan/motor are refused while the master is running its own sweep.
const MOTION_COMMANDS = new Set(['setFanSpeed', 'setAngle', 'zeroMotor']);

// ----- discovery (who is master on this LAN) --------------------------------------------------
// Every app that owns the controller link (USB, or Ethernet when there is no USB) broadcasts a small
// UDP beacon. Other apps list those masters so an operator can connect without typing an IP, and an
// app holding the controller over Ethernet steps aside when it hears a USB master (USB always wins).
// The beacon carries no secrets -- the access code is still required to connect.
const DISCOVERY_PORT = 8091;
const BEACON_INTERVAL_MS = 2000;
const MASTER_TTL_MS = 7000;
const INSTANCE_ID = crypto.randomBytes(6).toString('hex');
const masters = new Map();
let beaconSocket = null;
let beaconTimer = null;
let lastDiscoveredJson = '[]';

function broadcastAddresses() {
    const found = new Set(['255.255.255.255']);
    Object.values(os.networkInterfaces()).forEach((list) => (list || []).forEach((entry) => {
        if (entry.family !== 'IPv4' || entry.internal || !entry.netmask) return;
        const ip = entry.address.split('.').map(Number);
        const mask = entry.netmask.split('.').map(Number);
        found.add(ip.map((octet, index) => (octet | (~mask[index] & 255))).join('.'));
    }));
    return [...found];
}

function publishDiscovered() {
    const list = [...masters.values()].map((master) => ({ id: master.id, name: master.name, host: master.host, port: master.port, mode: master.mode, hardware: master.hardware }));
    const usbMaster = list.find((master) => master.hardware === 'usb');
    serial.setEthernetYield(usbMaster ? `USB master ${usbMaster.name} (${usbMaster.host}) is controlling the tunnel; Ethernet link released` : null);
    state.network.ethernetYield = usbMaster ? { name: usbMaster.name, host: usbMaster.host } : null;
    const json = JSON.stringify(list) + JSON.stringify(state.network.ethernetYield);
    if (json === lastDiscoveredJson) return;
    lastDiscoveredJson = json;
    state.network.discovered = list;
    publish();
}

function onBeacon(buffer, remote) {
    let beacon;
    try { beacon = JSON.parse(buffer.toString('utf8')); } catch (_error) { return; }
    if (!beacon || beacon.app !== 'wind-tunnel-master' || beacon.id === INSTANCE_ID) return;
    const port = Number(beacon.port);
    if (!isValidPort(port) || !['usb', 'ethernet'].includes(beacon.hardware) || !RELAY_MODES.includes(beacon.mode)) return;
    masters.set(beacon.id, { id: String(beacon.id).slice(0, 16), name: String(beacon.name || 'Wind Tunnel PC').slice(0, 40), host: remote.address, port, mode: beacon.mode, hardware: beacon.hardware, seen: Date.now() });
    publishDiscovered();
}

function sendBeacon() {
    const now = Date.now();
    let changed = false;
    masters.forEach((master, id) => { if (now - master.seen > MASTER_TTL_MS) { masters.delete(id); changed = true; } });
    if (changed) publishDiscovered();
    // Only the app that actually owns the hardware link announces itself; remote clients never do.
    if (!beaconSocket || !state.connected || state.simulation || !['usb', 'ethernet'].includes(state.transport)) return;
    const message = Buffer.from(JSON.stringify({ app: 'wind-tunnel-master', v: 1, id: INSTANCE_ID, name: os.hostname(), port: settings.relay.port, mode: settings.relay.mode, hardware: state.transport }));
    broadcastAddresses().forEach((address) => { try { beaconSocket.send(message, DISCOVERY_PORT, address); } catch (_error) { /* an unreachable interface must not stop the others */ } });
}

function startDiscovery() {
    if (beaconSocket) return;
    try {
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        socket.on('error', (error) => { console.log(`[network] Discovery unavailable: ${error.message}`); try { socket.close(); } catch (_error) { /* closed */ } if (beaconSocket === socket) { beaconSocket = null; clearInterval(beaconTimer); } });
        socket.on('message', onBeacon);
        socket.bind(DISCOVERY_PORT, () => { try { socket.setBroadcast(true); } catch (_error) { /* no broadcast support */ } });
        beaconSocket = socket;
        beaconTimer = setInterval(sendBeacon, BEACON_INTERVAL_MS);
    } catch (error) { console.log(`[network] Discovery unavailable: ${error.message}`); }
}

function stopDiscovery() {
    clearInterval(beaconTimer);
    beaconTimer = null;
    if (beaconSocket) { try { beaconSocket.close(); } catch (_error) { /* already closed */ } }
    beaconSocket = null;
}

// ----- settings ------------------------------------------------------------------------------

function generateAccessCode() {
    const bytes = crypto.randomBytes(8);
    const chars = Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function normaliseCode(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function loadSettings() {
    const saved = readConfig().network || {};
    const ethernet = saved.ethernet || {};
    const relay = saved.relay || {};
    const remote = saved.remote || {};
    return {
        ethernet: { enabled: Boolean(ethernet.enabled), host: String(ethernet.host || ''), port: Number(ethernet.port) || DEFAULT_ETHERNET_PORT },
        relay: {
            mode: RELAY_MODES.includes(relay.mode) ? relay.mode : 'off',
            port: Number(relay.port) || RELAY_DEFAULT_PORT,
            accessCode: relay.accessCode || generateAccessCode()
        },
        remote: { host: String(remote.host || ''), port: Number(remote.port) || RELAY_DEFAULT_PORT }
    };
}

let settings = loadSettings();

function saveSettings() {
    updateConfig({ network: settings });
}

function isValidPort(value) {
    return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function publicSettings() {
    return { ...settings, relayRunning: Boolean(relayServer), addresses: localAddresses(), relayLastError: relayLastError };
}

function localAddresses() {
    const found = [];
    Object.values(os.networkInterfaces()).forEach((list) => (list || []).forEach((entry) => {
        if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address);
    }));
    return found;
}

// ----- relay (master side) -------------------------------------------------------------------

let relayServer = null;
let relayWss = null;
let relayLastError = null;
let keepaliveTimer = null;
let broadcastTimer = null;
let lastBroadcastAt = 0;
let nextClientId = 1;
const relayClients = new Map(); // ws -> client record
const authFailures = new Map(); // ip -> { count, lockedUntil }

// Only what a remote operator needs to watch the tunnel. Diagnostics, logging paths, Admin state and
// experiment selections stay local to the master.
function snapshot() {
    return {
        connected: state.connected,
        connecting: state.connecting,
        linkDegraded: state.linkDegraded,
        transport: state.transport,
        simulation: state.simulation,
        apiVersion: state.apiVersion,
        fanSpeed: state.fanSpeed,
        angle: state.angle,
        sensors: state.sensors,
        sensorSampleSeq: state.sensorSampleSeq,
        leds: state.leds,
        sweep: { running: state.sweep.running, type: state.sweep.type }
    };
}

function publishRelayStatus() {
    state.network.relay = {
        running: Boolean(relayServer),
        mode: settings.relay.mode,
        port: relayServer ? settings.relay.port : null,
        clients: [...relayClients.values()].filter((client) => client.authed).map((client) => ({
            id: client.id, name: client.name, address: client.address, since: client.since, commands: client.commands, lastCommandAt: client.lastCommandAt
        }))
    };
    publish();
}

function sendJson(ws, message) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(message)); } catch (_error) { /* the close handler cleans up */ }
}

function broadcastState() {
    if (!relayServer) return;
    broadcastTimer = null;
    lastBroadcastAt = Date.now();
    const message = { type: 'state', access: settings.relay.mode, state: snapshot() };
    relayClients.forEach((client, ws) => { if (client.authed) sendJson(ws, message); });
}

// Coalesces bursts (every serial tx/rx publishes) into one update per BROADCAST_MIN_INTERVAL_MS.
function scheduleBroadcast() {
    if (!relayServer || broadcastTimer || !relayClients.size) return;
    const wait = Math.max(0, BROADCAST_MIN_INTERVAL_MS - (Date.now() - lastBroadcastAt));
    broadcastTimer = setTimeout(broadcastState, wait);
}

function clientAddress(request) {
    return String(request.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function isLockedOut(address) {
    const entry = authFailures.get(address);
    return Boolean(entry && entry.lockedUntil > Date.now());
}

function recordAuthFailure(address) {
    const entry = authFailures.get(address) || { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= AUTH_MAX_FAILURES) { entry.lockedUntil = Date.now() + AUTH_LOCKOUT_MS; entry.count = 0; }
    authFailures.set(address, entry);
}

function codeMatches(supplied) {
    const expected = Buffer.from(normaliseCode(settings.relay.accessCode));
    const actual = Buffer.from(normaliseCode(supplied));
    // Hash both so the comparison is constant-time regardless of the supplied length.
    const digest = (buffer) => crypto.createHash('sha256').update(buffer).digest();
    return expected.length > 0 && crypto.timingSafeEqual(digest(expected), digest(actual));
}

function auditRelay(client, event, extra = {}) {
    appendAudit({ source: 'remote', command: event, payload: [], result: extra.result || 'ok', client: `${client.name} (${client.address})`, ...extra });
}

async function handleClientCommand(ws, client, message) {
    const reply = (ok, error, result) => sendJson(ws, { type: 'result', id: message.id, ok, ...(error ? { error } : {}), ...(result ? { result } : {}) });
    const handler = Object.prototype.hasOwnProperty.call(RELAY_COMMANDS, message.name) ? RELAY_COMMANDS[message.name] : null;
    if (!handler) { reply(false, 'Unknown command'); return; }
    // Re-read the policy per command: Admin can switch a live session to view-only at any time.
    if (settings.relay.mode !== 'control') { reply(false, 'This connection is view-only. The master PC has not allowed remote control.'); return; }
    if (MOTION_COMMANDS.has(message.name) && state.sweep.running) { reply(false, 'A sweep is running on the master PC; stop it first.'); return; }
    if (!state.connected) { reply(false, 'The controller is not connected.'); return; }
    const now = Date.now();
    client.window = client.window.filter((time) => now - time < 1000);
    if (client.window.length >= MAX_COMMANDS_PER_SECOND) { reply(false, 'Too many commands; slow down.'); return; }
    client.window.push(now);
    client.commands += 1;
    client.lastCommandAt = new Date().toISOString();
    try {
        const args = Array.isArray(message.args) ? message.args.slice(0, 4) : [];
        await handler(args);
        reply(true);
        auditRelay(client, message.name, { args: args.map((arg) => (typeof arg === 'object' ? '[object]' : arg)) });
        publishRelayStatus();
    } catch (error) {
        reply(false, error.message);
        auditRelay(client, message.name, { result: 'failed', error: error.message });
    }
}

function onClientConnection(ws, request) {
    const address = clientAddress(request);
    const client = { id: nextClientId, name: 'Unnamed device', address, authed: false, since: null, commands: 0, lastCommandAt: null, window: [], alive: true };
    nextClientId += 1;
    relayClients.set(ws, client);
    const helloTimer = setTimeout(() => { if (!client.authed) ws.close(4401, 'Authentication timed out'); }, HELLO_TIMEOUT_MS);

    ws.on('pong', () => { client.alive = true; });
    ws.on('message', (data) => {
        let message;
        try { message = JSON.parse(data.toString('utf8')); } catch (_error) { return; }
        if (!message || typeof message !== 'object') return;
        if (!client.authed) {
            if (message.type !== 'hello') return;
            if (isLockedOut(address)) { sendJson(ws, { type: 'denied', error: 'Too many failed attempts. Try again in a minute.' }); ws.close(4403, 'Locked out'); return; }
            if (!codeMatches(message.code)) {
                recordAuthFailure(address);
                sendJson(ws, { type: 'denied', error: 'Wrong access code.' });
                ws.close(4403, 'Wrong access code');
                return;
            }
            clearTimeout(helloTimer);
            authFailures.delete(address);
            client.authed = true;
            client.since = new Date().toISOString();
            client.name = String(message.name || 'Unnamed device').slice(0, 40);
            sendJson(ws, { type: 'welcome', access: settings.relay.mode, state: snapshot() });
            auditRelay(client, 'connect');
            publishRelayStatus();
            return;
        }
        if (message.type === 'cmd') handleClientCommand(ws, client, message);
    });
    ws.on('close', () => {
        clearTimeout(helloTimer);
        relayClients.delete(ws);
        if (client.authed) { auditRelay(client, 'disconnect'); publishRelayStatus(); }
    });
    ws.on('error', () => { /* 'close' follows */ });
}

function serveWebFile(request, response) {
    const entry = WEB_FILES[(request.url || '/').split('?')[0]];
    if (!entry) { response.writeHead(404, { 'Content-Type': 'text/plain' }); response.end('Not found'); return; }
    fs.readFile(path.join(__dirname, '..', 'renderer', entry[0]), (error, body) => {
        if (error) { response.writeHead(500, { 'Content-Type': 'text/plain' }); response.end('Unavailable'); return; }
        response.writeHead(200, {
            'Content-Type': entry[1],
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            'X-Content-Type-Options': 'nosniff'
        });
        response.end(body);
    });
}

function stopRelay() {
    clearTimeout(broadcastTimer);
    broadcastTimer = null;
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
    const server = relayServer;
    const wss = relayWss;
    relayServer = null;
    relayWss = null;
    relayClients.forEach((_client, ws) => { try { ws.close(1001, 'Relay stopped'); } catch (_error) { /* already closed */ } });
    relayClients.clear();
    if (wss) try { wss.close(); } catch (_error) { /* already closed */ }
    if (server) try { server.close(); } catch (_error) { /* already closed */ }
    publishRelayStatus();
}

function startRelay() {
    stopRelay();
    relayLastError = null;
    if (settings.relay.mode === 'off' || state.transport === 'remote') { publishRelayStatus(); return Promise.resolve(); }
    return new Promise((resolve) => {
        const server = http.createServer(serveWebFile);
        const wss = new WebSocket.WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
        server.on('upgrade', (request, socket, head) => {
            const pathname = (request.url || '').split('?')[0];
            if (pathname !== '/ws' || relayClients.size >= MAX_CLIENTS) { socket.destroy(); return; }
            wss.handleUpgrade(request, socket, head, (ws) => onClientConnection(ws, request));
        });
        server.once('error', (error) => {
            relayLastError = error.code === 'EADDRINUSE' ? `Port ${settings.relay.port} is already in use.` : error.message;
            console.log(`[network] Relay failed to start: ${error.message}`);
            relayServer = null;
            relayWss = null;
            publishRelayStatus();
            resolve();
        });
        server.listen(settings.relay.port, '0.0.0.0', () => {
            relayServer = server;
            relayWss = wss;
            keepaliveTimer = setInterval(() => {
                relayClients.forEach((client, ws) => {
                    if (!client.alive) { ws.terminate(); return; }
                    client.alive = false;
                    try { ws.ping(); } catch (_error) { /* the close handler cleans up */ }
                });
            }, KEEPALIVE_MS);
            console.log(`[network] Relay listening on port ${settings.relay.port} (${settings.relay.mode})`);
            publishRelayStatus();
            resolve();
        });
    });
}

onPublish(() => scheduleBroadcast());

// ----- remote client side --------------------------------------------------------------------

let remoteSocket = null;
let remoteWanted = null; // { host, port, code } while the operator wants to stay connected
let remoteReconnectTimer = null;
let remoteAccessLevel = null;
let nextCommandId = 1;
const pendingRemote = new Map();

function setRemoteStatus(patch) {
    state.network.remote = { ...state.network.remote, ...patch };
}

function applySnapshot(remote) {
    if (!remote || typeof remote !== 'object') return;
    state.connected = Boolean(remote.connected);
    state.connecting = Boolean(remote.connecting);
    state.linkDegraded = Boolean(remote.linkDegraded);
    state.simulation = Boolean(remote.simulation);
    if (Number.isFinite(remote.fanSpeed)) state.fanSpeed = remote.fanSpeed;
    if (Number.isFinite(remote.angle)) state.angle = remote.angle;
    if (remote.sensors && ['lift', 'drag', 'pressure', 'velocity'].every((key) => Number.isFinite(remote.sensors[key]))) {
        state.sensors = { lift: remote.sensors.lift, drag: remote.sensors.drag, pressure: remote.sensors.pressure, velocity: remote.sensors.velocity };
    }
    if (Number.isFinite(remote.sensorSampleSeq)) state.sensorSampleSeq = remote.sensorSampleSeq;
    if (remote.leds && typeof remote.leds === 'object') state.leds = remote.leds;
    setRemoteStatus({ hardwareTransport: remote.transport || null, masterSweepRunning: Boolean(remote.sweep && remote.sweep.running) });
}

function failPendingRemote(message) {
    pendingRemote.forEach((entry) => { clearTimeout(entry.timer); entry.reject(new Error(message)); });
    pendingRemote.clear();
}

// While a reconnect is pending the app stays in 'remote' mode (offline) so the local USB/Ethernet
// scanner cannot grab the hardware behind the master's back.
function clearRemoteState({ keepRemoteMode = false } = {}) {
    state.connected = false;
    state.connecting = false;
    state.linkDegraded = false;
    state.port = null;
    state.transport = keepRemoteMode ? 'remote' : null;
    state.remoteAccess = null;
    state.sensors = { lift: 0, drag: 0, pressure: 0, velocity: 0 };
    state.fanSpeed = 0;
    state.angle = 0;
    setRemoteStatus({ connected: false, hardwareTransport: null, masterSweepRunning: false });
}

function scheduleRemoteReconnect() {
    clearTimeout(remoteReconnectTimer);
    if (!remoteWanted) return;
    remoteReconnectTimer = setTimeout(() => {
        if (!remoteWanted) return;
        // A denial during reconnect (the master changed its access code) clears remoteWanted: give up cleanly.
        openRemote(remoteWanted).catch(() => { if (remoteWanted) scheduleRemoteReconnect(); else disconnectRemote(); });
    }, REMOTE_RECONNECT_MS);
}

function openRemote({ host, port, code }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (error) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(); };
        const socket = new WebSocket(`ws://${host}:${port}/ws`, { handshakeTimeout: 5000, perMessageDeflate: false, maxPayload: 64 * 1024 });
        const timer = setTimeout(() => { settle(new Error('The master did not answer in time.')); try { socket.terminate(); } catch (_error) { /* gone */ } }, 8000);
        socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', code, name: os.hostname() })));
        socket.on('message', (data) => {
            let message;
            try { message = JSON.parse(data.toString('utf8')); } catch (_error) { return; }
            if (message.type === 'denied') { remoteWanted = null; settle(new Error(message.error || 'Access denied.')); return; }
            if (message.type === 'welcome') {
                remoteSocket = socket;
                remoteAccessLevel = message.access;
                state.transport = 'remote';
                state.remoteAccess = message.access;
                state.port = `${host}:${port}`;
                applySnapshot(message.state);
                setRemoteStatus({ connected: true, host, port });
                publish();
                settle();
                return;
            }
            if (message.type === 'state' && remoteSocket === socket) {
                remoteAccessLevel = message.access;
                state.remoteAccess = message.access;
                applySnapshot(message.state);
                publish();
                return;
            }
            if (message.type === 'result') {
                const entry = pendingRemote.get(message.id);
                if (!entry) return;
                pendingRemote.delete(message.id);
                clearTimeout(entry.timer);
                if (message.ok) entry.resolve({ ok: true }); else entry.resolve({ ok: false, message: message.error || 'Command refused by the master.' });
            }
        });
        socket.on('error', (error) => settle(error));
        socket.on('close', () => {
            const wasActive = remoteSocket === socket;
            if (wasActive) {
                remoteSocket = null;
                failPendingRemote('Connection to the master was lost.');
                clearRemoteState({ keepRemoteMode: Boolean(remoteWanted) });
                publish();
                scheduleRemoteReconnect();
                if (!remoteWanted) disconnectRemote();
            }
            settle(new Error('Could not connect to the master.'));
        });
    });
}

async function connectRemote({ host, port, code }) {
    const target = { host: String(host || '').trim(), port: Number(port), code: String(code || '') };
    if (!target.host) return { ok: false, message: 'Enter the master PC address.' };
    if (!isValidPort(target.port)) return { ok: false, message: 'Port must be a whole number from 1 to 65535.' };
    if (!normaliseCode(target.code)) return { ok: false, message: 'Enter the access code shown on the master PC.' };
    // A remote session replaces the local hardware link: stop anything driving the fan first.
    await disconnectRemote({ silent: true });
    sweeps.stopSweep();
    serial.disconnect();
    stopRelay();
    state.transport = 'remote';
    state.connecting = true;
    publish();
    remoteWanted = target;
    try {
        await openRemote(target);
    } catch (error) {
        remoteWanted = null;
        state.transport = null;
        state.connecting = false;
        publish();
        startRelay();
        serial.setEthernetTarget(settings.ethernet);
        return { ok: false, message: error.message };
    }
    state.connecting = false;
    settings.remote = { host: target.host, port: target.port };
    saveSettings();
    publish();
    return { ok: true, message: `Connected to ${target.host}:${target.port} (${remoteAccessLevel === 'control' ? 'view and control' : 'view only'}).` };
}

async function disconnectRemote({ silent = false } = {}) {
    const wasRemote = state.transport === 'remote';
    remoteWanted = null;
    clearTimeout(remoteReconnectTimer);
    const socket = remoteSocket;
    remoteSocket = null;
    failPendingRemote('Disconnected from the master.');
    if (socket) { try { socket.close(); } catch (_error) { /* already closed */ } }
    if (wasRemote) {
        clearRemoteState();
        publish();
        // Hand the local hardware scanner and the relay back; the USB/Ethernet scan resumes within ~2 s.
        if (!silent) { startRelay(); serial.setEthernetTarget(settings.ethernet); }
    }
    return { ok: true };
}

function remoteCommand(name, args) {
    return new Promise((resolve) => {
        if (!remoteSocket || remoteSocket.readyState !== WebSocket.OPEN) { resolve({ ok: false, message: 'Not connected to the master PC.' }); return; }
        if (remoteAccessLevel !== 'control') { resolve({ ok: false, message: 'This connection is view-only.' }); return; }
        const id = nextCommandId;
        nextCommandId += 1;
        const timer = setTimeout(() => { pendingRemote.delete(id); resolve({ ok: false, message: 'The master did not answer in time.' }); }, COMMAND_TIMEOUT_MS);
        pendingRemote.set(id, { resolve, reject: (error) => resolve({ ok: false, message: error.message }), timer });
        remoteSocket.send(JSON.stringify({ type: 'cmd', id, name, args }));
    });
}

control.setRemoteForwarder(async (name, args) => {
    const result = await remoteCommand(name, args);
    // The mirrored state advances when the master next broadcasts; fan/angle echo straight away so the slider does not snap back.
    if (result.ok && name === 'setFanSpeed') state.fanSpeed = Math.max(0, Math.min(100, Number(args[0]) || 0));
    if (result.ok && name === 'setAngle') state.angle = Math.max(-180, Math.min(180, Number(args[0]) || 0));
    publish();
    return name === 'zeroSensors' ? { ok: result.ok, message: result.ok ? 'Sensor zero command sent to the master PC' : result.message } : state;
});

// ----- admin-facing API ----------------------------------------------------------------------

function init() {
    state.network.relay.mode = settings.relay.mode;
    serial.setEthernetTarget(settings.ethernet);
    startDiscovery();
    return startRelay();
}

function getSettings() {
    return publicSettings();
}

function saveEthernetSettings({ enabled, host, port }) {
    const portNumber = Number(port);
    const cleanHost = String(host || '').trim();
    if (!isValidPort(portNumber)) return { ok: false, message: 'Port must be a whole number from 1 to 65535.' };
    if (enabled && !/^[A-Za-z0-9.-]+$/.test(cleanHost)) return { ok: false, message: 'Enter the controller IP address or host name.' };
    settings.ethernet = { enabled: Boolean(enabled), host: cleanHost, port: portNumber };
    saveSettings();
    serial.setEthernetTarget(settings.ethernet);
    return { ok: true, message: enabled ? 'Ethernet fallback saved. It is used only when no USB controller is connected.' : 'Ethernet fallback disabled.' };
}

async function saveRelaySettings({ mode, port }) {
    const portNumber = Number(port);
    if (!RELAY_MODES.includes(mode)) return { ok: false, message: 'Unknown access mode.' };
    if (!isValidPort(portNumber)) return { ok: false, message: 'Port must be a whole number from 1 to 65535.' };
    const portChanged = portNumber !== settings.relay.port;
    settings.relay.mode = mode;
    settings.relay.port = portNumber;
    saveSettings();
    if (portChanged || !relayServer || mode === 'off') {
        await startRelay();
    } else {
        // Same port: keep clients connected but tell them the new permission straight away.
        relayClients.forEach((client, ws) => { if (client.authed) sendJson(ws, { type: 'state', access: mode, state: snapshot() }); });
        publishRelayStatus();
    }
    if (relayLastError) return { ok: false, message: relayLastError };
    const text = { off: 'Remote access is off.', view: 'Remote devices can view live data only.', control: 'Remote devices can view live data and send fan, angle, zero and LED commands.' }[mode];
    return { ok: true, message: text };
}

async function regenerateAccessCode() {
    settings.relay.accessCode = generateAccessCode();
    saveSettings();
    // Existing sessions were authorised with the old code; drop them.
    relayClients.forEach((_client, ws) => { try { ws.close(4401, 'Access code changed'); } catch (_error) { /* already closed */ } });
    return { ok: true, accessCode: settings.relay.accessCode };
}

async function scanNetwork(port) {
    const targetPort = isValidPort(Number(port)) ? Number(port) : DEFAULT_ETHERNET_PORT;
    const prefixes = new Set();
    Object.values(os.networkInterfaces()).forEach((list) => (list || []).forEach((entry) => {
        if (entry.family === 'IPv4' && !entry.internal) prefixes.add(entry.address.split('.').slice(0, 3).join('.'));
    }));
    const candidates = [];
    prefixes.forEach((prefix) => { for (let host = 1; host < 255; host += 1) candidates.push(`${prefix}.${host}`); });
    const found = [];
    let cursor = 0;
    const worker = async () => {
        while (cursor < candidates.length) {
            const host = candidates[cursor];
            cursor += 1;
            const version = await probe(host, targetPort, 700);
            if (version !== null) found.push({ host, port: targetPort, apiVersion: version });
        }
    };
    await Promise.all(Array.from({ length: 48 }, worker));
    found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
    return { ok: true, devices: found, scanned: candidates.length, subnets: [...prefixes].map((prefix) => `${prefix}.0/24`) };
}

function shutdown() {
    stopDiscovery();
    remoteWanted = null;
    clearTimeout(remoteReconnectTimer);
    stopRelay();
}

module.exports = {
    init, getSettings, saveEthernetSettings, saveRelaySettings, regenerateAccessCode, scanNetwork,
    connectRemote, disconnectRemote, remoteCommand, shutdown, startRelay
};
