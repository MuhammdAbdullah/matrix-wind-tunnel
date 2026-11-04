const { execFile } = require('child_process');

// One ICMP echo to the controller. The W5500 answers ping in hardware, so this works even while the controller's
// main loop is busy (a held touch blocks the JSON API for ~5 s but not ping). That makes "ping fails" mean the
// cable/network is down, while "ping works but the API is silent" means the controller is just busy: something
// the JSON heartbeat alone cannot tell apart. Resolves true only on a real echo reply (TTL= in the output; Windows
// prints "Reply from" for "Destination host unreachable" too).
function pingOnce(host, timeoutMs = 600) {
    return new Promise((resolve) => {
        // The host comes from saved settings: never let it be read as an option of ping.
        if (!/^[0-9a-zA-Z][0-9a-zA-Z.:-]*$/.test(String(host || ''))) { resolve(false); return; }
        let args;
        if (process.platform === 'win32') args = ['-n', '1', '-w', String(timeoutMs), host];
        else if (process.platform === 'darwin') args = ['-c', '1', '-W', String(timeoutMs), host];
        else args = ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), host];
        try {
            execFile('ping', args, { windowsHide: true, timeout: timeoutMs + 1500 }, (error, stdout) => {
                resolve(!error && /ttl=/i.test(String(stdout)));
            });
        } catch (_error) { resolve(false); }
    });
}

module.exports = { pingOnce };
