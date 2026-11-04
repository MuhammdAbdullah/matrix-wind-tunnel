'use strict';
// Mock Wind Tunnel controller for the Ethernet access-control protocol (docs/ethernet-access-control.md).
// Not shipped with the app. Usage:
//   node tools/mock-controller.js [--port 1245] [--legacy] [--usb-live]
// then type `usb on` / `usb off` on stdin to simulate a USB host appearing/disappearing.
// Also used as a module by tools/netauth-selftest.js.
//
// Handshake: app {"hi":1} -> controller {"hey":1}, app {"com":1} -> controller {"ok":1}. Anything else, or
// silence for authTimeoutMs, and the client is dropped ({"auth":0|4}) and the controller "renews its address".

const WebSocket = require('ws');

function startMock({ port = 0, legacy = false, usbLive = false, stallAfterHi = false, authTimeoutMs = 10000, log = () => {} } = {}) {
    const controller = {
        usbLive,
        fanSpeed: 0,
        network: { ip: '192.168.1.150', port: 1245, dhcp: 1, mac: '00:08:DC:00:00:00', sip: '192.168.1.150' },
        clients: [],
        // Close codes the server saw from clients: 1006 = the client vanished without a close handshake.
        closeCodes: [],
        unverifiedCommands: 0,
        // How many times a failed client made the controller re-run DHCP (renew its address).
        renewals: 0
    };
    const server = new WebSocket.WebSocketServer({ port, host: '127.0.0.1', perMessageDeflate: false });

    server.on('connection', (ws) => {
        const client = { ws, phase: legacy ? 'verified' : 'hi', timer: null };
        controller.clients.push(client);
        const send = (object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(object)); };
        const drop = (code) => {
            clearTimeout(client.timer);
            send({ auth: code });
            if (code !== 2) controller.renewals += 1;
            setTimeout(() => { try { ws.close(); } catch (_error) { /* gone */ } }, 20);
        };
        client.drop = drop;
        ws.on('close', (code) => { clearTimeout(client.timer); controller.closeCodes.push(code); log(`client closed (${code})`); });
        ws.on('error', () => {});

        if (!legacy) {
            if (controller.usbLive) { drop(2); return; }
            client.timer = setTimeout(() => drop(4), authTimeoutMs);
        }

        ws.on('message', (data) => {
            let message;
            try { message = JSON.parse(data.toString('utf8')); } catch (_error) { return; }
            if (client.phase === 'hi') {
                if (!('hi' in message)) { controller.unverifiedCommands += 1; drop(0); return; }
                client.phase = 'com';
                if (!stallAfterHi) send({ hey: 1 });
                return;
            }
            if (client.phase === 'com') {
                if (!('com' in message)) { controller.unverifiedCommands += 1; drop(0); return; }
                client.phase = 'verified';
                clearTimeout(client.timer);
                controller.fanSpeed = 0;
                send({ ok: 1 });
                return;
            }
            if (client.phase !== 'verified') return;
            if (controller.usbLive && !legacy) { drop(2); return; }
            if ('version' in message) send({ version: 2 });
            else if ('readsensors' in message) send({ lift: 1.5, drag: 0.5, pressure: 12.25, velocity: 3.5 });
            else if ('fanspeed' in message) controller.fanSpeed = Number(message.fanspeed);
            else if ('netinfo' in message) send({ ip: controller.network.ip, port: controller.network.port, dhcp: controller.network.dhcp });
            else if ('macinfo' in message) send({ mac: controller.network.mac, sip: controller.network.sip });
            else if ('ip0' in message) {
                controller.network.sip = [message.ip0, message.ip1, message.ip2, message.ip3].join('.');
                controller.network.port = Number(message.port);
                controller.network.dhcp = Number(message.dhcp);
                if ('mac0' in message) controller.network.mac = [0, 1, 2, 3, 4, 5].map((index) => Number(message[`mac${index}`]).toString(16).padStart(2, '0')).join(':').toUpperCase();
                controller.network.ip = controller.network.dhcp ? controller.network.ip : controller.network.sip;
            }
        });
    });

    // A USB host appears: every Ethernet client is told and dropped.
    controller.setUsbLive = (live) => {
        controller.usbLive = Boolean(live);
        if (live) controller.clients.forEach((client) => { if (client.ws.readyState === WebSocket.OPEN) client.drop(2); });
    };
    controller.close = () => new Promise((resolve) => {
        controller.clients.forEach((client) => { try { client.ws.terminate(); } catch (_error) { /* gone */ } });
        server.close(() => resolve());
    });
    return new Promise((resolve) => server.on('listening', () => { controller.port = server.address().port; resolve(controller); }));
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
    startMock({
        port: Number(option('--port', 1245)),
        legacy: args.includes('--legacy'),
        usbLive: args.includes('--usb-live'),
        log: (text) => console.log(`[mock] ${text}`)
    }).then((controller) => {
        console.log(`[mock] listening on ws://127.0.0.1:${controller.port}${args.includes('--legacy') ? ' (legacy)' : ''}. Type "usb on" / "usb off".`);
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (text) => {
            const line = text.trim().toLowerCase();
            if (line === 'usb on') { controller.setUsbLive(true); console.log('[mock] USB live'); }
            if (line === 'usb off') { controller.setUsbLive(false); console.log('[mock] USB idle'); }
        });
    });
}

module.exports = { startMock };
