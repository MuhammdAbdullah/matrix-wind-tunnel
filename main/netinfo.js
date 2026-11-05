const { CMD } = require('./protocol');
const { state, publish } = require('./state');
const serial = require('./serial');

// The controller's own view of its network (live IP, port, DHCP, MAC). Contract: docs/ethernet-access-control.md.

const INFO_TIMEOUT_MS = 1200;
const INFO_RETRIES = 1;
const CONNECT_READ_DELAY_MS = 500;
const SIMULATED_INFO = { supported: true, simulated: true, ip: '192.168.1.150', port: 1245, dhcp: true, mac: '00:08:DC:00:00:00', staticIp: '192.168.1.150' };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normaliseMac(text) {
    const parts = String(text || '').trim().split(/[:-]/);
    if (parts.length !== 6 || !parts.every((part) => /^[0-9a-fA-F]{2}$/.test(part))) return null;
    return parts.map((part) => part.toUpperCase()).join(':');
}

// The first three bytes (the OUI) are fixed at the W5500's own WIZnet block, 00:08:DC: bit 0 (multicast) and bit 1
// (locally administered) are both clear, as a unicast, globally unique address needs. Only the last three bytes
// (the NIC specific part) can be changed. Same rule as the firmware, which ignores any other OUI.
const MAC_OUI = '00:08:DC';

// null when valid, otherwise the reason.
function macProblem(text) {
    const mac = normaliseMac(text);
    if (!mac) return `Enter the MAC address as six hex pairs, for example ${MAC_OUI}:12:34:56.`;
    if (!mac.startsWith(`${MAC_OUI}:`)) return `The first three bytes of the MAC address are fixed at ${MAC_OUI}; only the last three can be changed.`;
    return null;
}

function macBytes(text) {
    return normaliseMac(text).split(':').map((part) => parseInt(part, 16));
}

function setControllerInfo(info) {
    state.network.controller = info;
    publish();
    return info;
}

// Reads netinfo + macinfo. Works on USB and Ethernet. A controller without this feature never answers the
// unknown keys, which is reported as { supported: false } rather than an error. Never throws.
async function readControllerInfo({ source = 'calibrator' } = {}) {
    if (state.simulation) return setControllerInfo({ ...SIMULATED_INFO, readAt: new Date().toISOString() });
    if (state.transport === 'remote') return { ok: false, supported: false, reason: 'remote', message: 'This PC is following a master PC; connect to the controller there.' };
    if (!state.connected) return { ok: false, supported: false, reason: 'not-connected', message: 'Connect to the controller to read its network settings.' };
    try {
        const options = { source, timeout: INFO_TIMEOUT_MS, retries: INFO_RETRIES, audit: false };
        const net = JSON.parse((await serial.sendBinary(CMD.NETINFO, Buffer.alloc(0), options)).toString('utf8'));
        const mac = JSON.parse((await serial.sendBinary(CMD.MACINFO, Buffer.alloc(0), options)).toString('utf8'));
        return setControllerInfo({
            ok: true,
            supported: true,
            ip: net.ip,
            port: net.port,
            dhcp: Boolean(net.dhcp),
            mac: normaliseMac(mac.mac) || mac.mac,
            staticIp: mac.sip,
            readAt: new Date().toISOString()
        });
    } catch (error) {
        if (error.linkDown) return { ok: false, supported: false, reason: 'link', message: `Could not read the controller's network settings: ${error.message}` };
        // Older firmware ignores the unknown keys, so the only symptom is a timeout. If this controller has
        // answered before, a timeout is transient (e.g. it is busy re-running DHCP), not "unsupported".
        const known = state.network.controller;
        if (known && known.supported) return { ok: false, supported: true, reason: 'timeout', message: `The controller did not answer in time: ${error.message}` };
        return setControllerInfo({ ok: true, supported: false, readAt: new Date().toISOString() });
    }
}

serial.onConnected(() => {
    if (state.simulation || state.transport === 'remote') return;
    setTimeout(() => { readControllerInfo({ source: 'system' }).catch(() => {}); }, CONNECT_READ_DELAY_MS);
});

// Compares what the controller reports against what a set-network request asked for.
function matchesRequest(info, request) {
    if (!info || !info.supported) return false;
    if (info.dhcp !== Boolean(request.dhcp)) return false;
    if (Number(info.port) !== Number(request.port)) return false;
    if (!request.dhcp && info.staticIp !== request.ip) return false;
    if (!request.dhcp && info.ip !== request.ip) return false;
    if (request.mac && normaliseMac(info.mac) !== normaliseMac(request.mac)) return false;
    return true;
}

module.exports = { readControllerInfo, matchesRequest, normaliseMac, macProblem, macBytes, MAC_OUI };
