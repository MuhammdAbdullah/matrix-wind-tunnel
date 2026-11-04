'use strict';
// Diagnostic for the Ethernet handshake against a real controller (or tools/mock-controller.js). Prints every
// step with a millisecond timestamp so a failing controller shows WHERE it fails: before "hi" is even sent,
// after "hi", after "com", or only after a delay.
//
//   node tools/eth-probe.js <host> [--port 1245] [--hi-delay 0] [--no-hi] [--hold 3000] [--repeat 1] [--gap 2000]
//
//   --hi-delay ms   wait this long after the WebSocket opens before sending {"hi":1} (tests "controller not ready yet")
//   --no-hi         never send hi (does the controller reject on its own, with no message from us?)
//   --hold ms       after a successful handshake, keep the link open this long sending {"version":0} once a second
//   --repeat n      run the whole sequence n times, --gap ms apart (reproduce a flaky reconnect)
//
// Always closes the socket with a proper close handshake: an abrupt drop wedges the controller's single socket.
// Stop the Wind Tunnel app first (the controller serves one Ethernet client).

const WebSocket = require('ws');

function parseArgs(argv) {
    const options = { host: '', port: 1245, hiDelay: 0, noHi: false, hold: 3000, repeat: 1, gap: 2000 };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--port') options.port = Number(argv[++i]);
        else if (arg === '--hi-delay') options.hiDelay = Number(argv[++i]);
        else if (arg === '--no-hi') options.noHi = true;
        else if (arg === '--hold') options.hold = Number(argv[++i]);
        else if (arg === '--repeat') options.repeat = Number(argv[++i]);
        else if (arg === '--gap') options.gap = Number(argv[++i]);
        else if (!arg.startsWith('--')) options.host = arg;
    }
    return options;
}

function runOnce(options, index) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const log = (text) => console.log(`[run ${index}] +${String(Date.now() - t0).padStart(5)} ms  ${text}`);
        const timers = [];
        let finished = false;
        let verified = false;
        const url = `ws://${options.host}:${options.port}`;
        log(`connecting ${url}`);
        const socket = new WebSocket(url, { handshakeTimeout: 8000, perMessageDeflate: false });
        const finish = (summary) => {
            if (finished) return;
            finished = true;
            timers.forEach(clearTimeout);
            log(`result: ${summary}`);
            const done = () => resolve(summary);
            if (socket.readyState === WebSocket.OPEN) {
                socket.once('close', (code) => { log(`closed politely (code ${code})`); done(); });
                socket.close();
                setTimeout(() => { try { socket.terminate(); } catch (_error) { /* gone */ } done(); }, 1500);
            } else {
                try { socket.terminate(); } catch (_error) { /* gone */ }
                done();
            }
        };
        const send = (text) => { log(`-> ${text}`); socket.send(text, (error) => { if (error) log(`send error: ${error.message}`); }); };
        timers.push(setTimeout(() => finish('TIMEOUT (no verified handshake within 15 s)'), 15000));

        socket.on('upgrade', (response) => log(`HTTP upgrade ${response.statusCode}`));
        socket.on('unexpected-response', (_request, response) => { log(`unexpected HTTP response ${response.statusCode}`); finish(`HTTP ${response.statusCode}`); });
        socket.on('open', () => {
            log('WebSocket open');
            if (options.noHi) { log('not sending hi (--no-hi); waiting for the controller to speak first'); return; }
            const go = () => send('{"hi":1}');
            if (options.hiDelay > 0) timers.push(setTimeout(go, options.hiDelay)); else go();
        });
        socket.on('message', (data) => {
            const text = data.toString('utf8');
            log(`<- ${text}`);
            let frame = null;
            try { frame = JSON.parse(text); } catch (_error) { /* not JSON */ }
            if (!frame) return;
            if ('auth' in frame) finish(`REFUSED auth:${frame.auth} (${frame.auth === 0 ? 'wrong/out-of-order message or no client state' : frame.auth === 2 ? 'USB in control' : 'handshake timeout'})`);
            else if ('hey' in frame) send('{"com":1}');
            else if ('ok' in frame && !verified) {
                verified = true;
                log('handshake verified; link is up');
                let n = 0;
                const ping = () => { n += 1; send('{"version":0}'); };
                if (options.hold > 0) {
                    ping();
                    const beat = setInterval(ping, 1000);
                    timers.push(setTimeout(() => { clearInterval(beat); finish(`VERIFIED and held ${options.hold} ms`); }, options.hold));
                } else finish('VERIFIED');
            }
        });
        socket.on('error', (error) => { log(`socket error: ${error.code || ''} ${error.message}`); finish(`ERROR ${error.code || error.message}`); });
        socket.on('close', (code) => { log(`socket closed by peer (code ${code})`); finish(verified ? 'CLOSED after verify' : 'CLOSED before verify'); });
    });
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (!options.host) { console.log('usage: node tools/eth-probe.js <host> [--port 1245] [--hi-delay ms] [--no-hi] [--hold ms] [--repeat n] [--gap ms]'); process.exit(2); }
    const results = [];
    for (let i = 1; i <= options.repeat; i += 1) {
        results.push(await runOnce(options, i));
        if (i < options.repeat) await new Promise((resolve) => setTimeout(resolve, options.gap));
    }
    console.log('\nSummary:');
    results.forEach((result, i) => console.log(`  run ${i + 1}: ${result}`));
    process.exit(0);
}

main();
