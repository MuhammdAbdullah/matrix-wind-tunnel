'use strict';
// Drives main/serial.js + main/netinfo.js over Ethernet against tools/mock-controller.js, under plain node
// (no Electron). Run with `npm run test:netauth` (called from netauth-selftest.js).
const assert = require('assert');
const { startMock } = require('./mock-controller');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async function integration(test) {
    const { state } = require('../main/state');
    const serial = require('../main/serial');
    const netinfo = require('../main/netinfo');

    await test('serial.js over Ethernet: handshake connect, netinfo/macinfo parsed, string replies validated', async () => {
        const mock = await startMock({});
        try {
            await serial.connectEthernet('127.0.0.1', mock.port);
            assert.ok(state.connected && state.transport === 'ethernet');
            assert.strictEqual(state.network.ethernetBlocked, null);
            await wait(900); // main/netinfo.js reads the controller on connect
            const info = state.network.controller;
            assert.ok(info && info.supported, 'controller info was not read on connect');
            assert.strictEqual(info.ip, '192.168.1.150');
            assert.strictEqual(info.mac, '00:08:DC:00:00:00');
            assert.strictEqual(info.dhcp, true);
            await serial.closeLink();
            await wait(150);
            assert.ok(mock.closeCodes.every((code) => code !== 1006), `abrupt close: ${mock.closeCodes}`);
        } finally { await mock.close(); }
    });

    await test('serial.js: USB in control then a good connect clears ethernetBlocked', async () => {
        const mock = await startMock({ usbLive: true });
        try {
            await assert.rejects(serial.connectEthernet('127.0.0.1', mock.port), /USB control/);
            assert.strictEqual(state.network.ethernetBlocked.code, 'USB_IN_CONTROL');
            mock.setUsbLive(false);
            await serial.connectEthernet('127.0.0.1', mock.port);
            assert.strictEqual(state.network.ethernetBlocked, null);
            await serial.closeLink();
        } finally { await mock.close(); }
    });

    await test('serial.js: a mid-session USB takeover drops the link and reports USB_IN_CONTROL', async () => {
        const mock = await startMock({});
        try {
            await serial.connectEthernet('127.0.0.1', mock.port);
            assert.ok(state.connected);
            mock.setUsbLive(true);
            await wait(600);
            assert.strictEqual(state.connected, false, 'link should have dropped');
            assert.strictEqual(state.network.ethernetBlocked.code, 'USB_IN_CONTROL');
        } finally { await mock.close(); }
    });

    await test('netinfo.js: MAC validation and read-back matching', async () => {
        assert.strictEqual(netinfo.macProblem('00:08:DC:12:34:56'), null);
        assert.ok(netinfo.macProblem('01:08:DC:12:34:56'), 'multicast must be refused');
        assert.ok(netinfo.macProblem('00:00:00:00:00:00'), 'all-zero must be refused');
        assert.ok(netinfo.macProblem('00:08:DC:12:34'), 'short MAC must be refused');
        const info = { supported: true, dhcp: false, port: 1245, ip: '10.0.0.9', staticIp: '10.0.0.9', mac: '02:01:00:00:00:10' };
        assert.ok(netinfo.matchesRequest(info, { dhcp: false, port: 1245, ip: '10.0.0.9', mac: '02:01:00:00:00:10' }));
        assert.ok(!netinfo.matchesRequest(info, { dhcp: false, port: 1246, ip: '10.0.0.9', mac: null }));
        assert.ok(!netinfo.matchesRequest(info, { dhcp: true, port: 1245, ip: '10.0.0.9', mac: null }));
        assert.ok(!netinfo.matchesRequest({ supported: false }, { dhcp: true, port: 1245 }));
    });

};
