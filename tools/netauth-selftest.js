'use strict';
// Self-test for Ethernet access control (Hi/Hey, COM/OK handshake): EthernetPort/probe against tools/mock-controller.js. Run with `npm run test:netauth`. Exits non-zero on any failure.

const assert = require('assert');
const WebSocket = require('ws');
const { EthernetPort, probe } = require('../main/ethernet');
const { startMock } = require('./mock-controller');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

async function test(name, body) {
    const started = Date.now();
    try {
        await body();
        results.push({ name, ok: true });
        console.log(`PASS  ${name} (${Date.now() - started} ms)`);
    } catch (error) {
        results.push({ name, ok: false });
        console.log(`FAIL  ${name}: ${error.message}`);
    }
}

const openPort = (port) => new Promise((resolve) => {
    const ethernet = new EthernetPort({ host: '127.0.0.1', port });
    ethernet.open((error) => resolve({ ethernet, error }));
});
const closePort = (ethernet) => new Promise((resolve) => ethernet.close(resolve));
const requestOnce = (ethernet, text) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no reply')), 2000);
    ethernet.once('data', (chunk) => { clearTimeout(timer); resolve(JSON.parse(chunk.toString('utf8'))); });
    ethernet.write(Buffer.from(text), (error) => { if (error) reject(error); });
});

async function withMock(options, body) {
    const mock = await startMock(options);
    try { await body(mock); } finally { await mock.close(); }
}
// The mock records the close code of every connection it saw; 1006 means a client vanished without the handshake.
const assertPoliteCloses = async (mock) => {
    await wait(150);
    assert.ok(mock.closeCodes.length > 0, 'the mock saw no client close');
    assert.ok(mock.closeCodes.every((code) => code !== 1006), `an abrupt close was seen: ${mock.closeCodes.join(',')}`);
};

(async () => {
    await test('Hi/Hey, COM/OK: connects, handshake frames never reach data', () => withMock({}, async (mock) => {
        const { ethernet, error } = await openPort(mock.port);
        assert.ifError(error);
        assert.strictEqual(ethernet.authenticated, true);
        const seen = [];
        ethernet.on('data', (chunk) => seen.push(chunk.toString('utf8')));
        const reply = await requestOnce(ethernet, '{"version":0}');
        assert.strictEqual(reply.version, 2);
        const sensors = await requestOnce(ethernet, '{"readsensors":0}');
        assert.strictEqual(sensors.pressure, 12.25);
        assert.ok(seen.every((text) => !text.includes('"hey"') && !text.includes('"ok"') && !text.includes('"auth"')), `handshake leaked: ${seen.join(' | ')}`);
        assert.strictEqual(mock.renewals, 0);
        await closePort(ethernet);
        await assertPoliteCloses(mock);
    }));

    await test('USB in control at connect: USB_IN_CONTROL, no address renewal', () => withMock({ usbLive: true }, async (mock) => {
        const { error } = await openPort(mock.port);
        assert.ok(error && error.code === 'USB_IN_CONTROL', `got ${error && error.code}`);
        assert.strictEqual(mock.renewals, 0);
        await assertPoliteCloses(mock);
    }));

    await test('USB takes over mid-session: error USB_IN_CONTROL, link closed', () => withMock({}, async (mock) => {
        const { ethernet, error } = await openPort(mock.port);
        assert.ifError(error);
        const failure = new Promise((resolve) => ethernet.once('error', resolve));
        mock.setUsbLive(true);
        const reported = await Promise.race([failure, wait(2000).then(() => null)]);
        assert.ok(reported && reported.isAuth && reported.code === 'USB_IN_CONTROL', `got ${reported && reported.code}`);
        assert.strictEqual(ethernet.isOpen, false);
        await assertPoliteCloses(mock);
    }));

    await test('legacy firmware (never says Hey): opens unauthenticated after the wait, API works', () => withMock({ legacy: true }, async (mock) => {
        const started = Date.now();
        const { ethernet, error } = await openPort(mock.port);
        assert.ifError(error);
        assert.strictEqual(ethernet.authenticated, false);
        assert.ok(Date.now() - started >= 1400, 'legacy detection should wait ~1.5 s for a Hey');
        assert.strictEqual((await requestOnce(ethernet, '{"version":0}')).version, 2);
        await closePort(ethernet);
        await assertPoliteCloses(mock);
    }));

    await test('another program (not the app) is dropped and the controller renews its address', () => withMock({}, async (mock) => {
        const socket = new WebSocket(`ws://127.0.0.1:${mock.port}`);
        const frames = [];
        socket.on('message', (data) => frames.push(JSON.parse(data.toString('utf8'))));
        await new Promise((resolve) => socket.once('open', resolve));
        mock.fanSpeed = 7;
        socket.send('{"fanspeed":90}');
        await new Promise((resolve) => socket.once('close', resolve));
        assert.ok(frames.some((frame) => frame.auth === 0), 'expected {"auth":0}');
        assert.strictEqual(mock.fanSpeed, 7);
        assert.strictEqual(mock.unverifiedCommands, 1);
        assert.strictEqual(mock.renewals, 1);
    }));

    await test('skipping a step (COM without Hi, or Hi then a command) is dropped', () => withMock({}, async (mock) => {
        for (const frames of [['{"com":1}'], ['{"hi":1}', '{"readsensors":0}']]) {
            const socket = new WebSocket(`ws://127.0.0.1:${mock.port}`);
            await new Promise((resolve) => socket.once('open', resolve));
            const closed = new Promise((resolve) => socket.once('close', resolve));
            frames.forEach((text) => socket.send(text));
            await closed;
        }
        assert.strictEqual(mock.unverifiedCommands, 2);
        assert.strictEqual(mock.renewals, 2);
    }));

    await test('netinfo/macinfo/set-network work after the handshake', () => withMock({}, async (mock) => {
        const { ethernet, error } = await openPort(mock.port);
        assert.ifError(error);
        const info = await requestOnce(ethernet, '{"netinfo":0}');
        assert.deepStrictEqual(info, { ip: '192.168.1.150', port: 1245, dhcp: 1 });
        assert.deepStrictEqual(await requestOnce(ethernet, '{"macinfo":0}'), { mac: '00:08:DC:00:00:00', sip: '192.168.1.150' });
        ethernet.write(Buffer.from('{"ip0":10,"ip1":0,"ip2":0,"ip3":9,"port":2000,"mac0":2,"mac1":1,"mac2":0,"mac3":0,"mac4":0,"mac5":16,"dhcp":0}'), () => {});
        await wait(100);
        assert.deepStrictEqual(await requestOnce(ethernet, '{"macinfo":0}'), { mac: '02:01:00:00:00:10', sip: '10.0.0.9' });
        await closePort(ethernet);
    }));

    await test('probe(): version for the app, locked status when USB is in control, legacy, nothing', async () => {
        await withMock({}, async (mock) => {
            assert.strictEqual(await probe('127.0.0.1', mock.port, 700), 2);
            await assertPoliteCloses(mock);
        });
        await withMock({ usbLive: true }, async (mock) => {
            assert.deepStrictEqual(await probe('127.0.0.1', mock.port, 700), { locked: 'usb-in-control' });
        });
        await withMock({ legacy: true }, async (mock) => {
            assert.strictEqual(await probe('127.0.0.1', mock.port, 700), 2);
        });
        assert.strictEqual(await probe('127.0.0.1', 1, 300), null);
    });

    await require('./netauth-integration')(test);

    const failed = results.filter((result) => !result.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();
