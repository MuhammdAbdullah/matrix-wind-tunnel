// Browser client for the relay hosted by the Wind Tunnel app (main/network.js). It only watches and,
// if the master allows it, sends the same fan/angle/zero commands as the desktop Control view.
// The master re-checks permission on every command, so hiding controls here is convenience only.
const $ = (id) => document.getElementById(id);

let socket = null;
let access = 'view';
let wantConnected = false;
let reconnectTimer = null;
let nextId = 1;
const pending = new Map();
let dragging = null;

function storedCode() {
    try { return sessionStorage.getItem('wt-code') || ''; } catch (_error) { return ''; }
}

function storeCode(code) {
    try { sessionStorage.setItem('wt-code', code); } catch (_error) { /* private mode: the code is just not remembered */ }
}

function setStatus(text, tone) {
    $('status').textContent = text;
    $('status').className = `pill ${tone || ''}`;
}

function show(id, visible) {
    $(id).classList.toggle('hidden', !visible);
}

function say(text) {
    $('message').textContent = text || '';
}

function num(value, digits = 1) {
    return Number.isFinite(value) ? value.toFixed(digits) : '-';
}

function applyAccess() {
    const control = access === 'control';
    show('controlCard', control);
    setStatus(control ? 'Connected · control' : 'Connected · view only', 'ok');
}

function render(snapshot) {
    show('loginCard', false);
    show('liveCard', true);
    show('disconnect', true);
    const s = snapshot.sensors || {};
    $('lift').textContent = num(s.lift);
    $('drag').textContent = num(s.drag);
    $('pressure').textContent = num(s.pressure);
    $('velocity').textContent = num(s.velocity, 2);
    $('fan').textContent = num(snapshot.fanSpeed, 0);
    $('angle').textContent = num(snapshot.angle, 0);
    show('sweepNote', Boolean(snapshot.sweep && snapshot.sweep.running));
    if (dragging !== 'fanSlider') { $('fanSlider').value = snapshot.fanSpeed; $('fanOut').textContent = Math.round(snapshot.fanSpeed); }
    if (dragging !== 'angleSlider') { $('angleSlider').value = snapshot.angle; $('angleOut').textContent = Math.round(snapshot.angle); }
    if (!snapshot.connected) { setStatus('Tunnel offline', 'warn'); say('The master PC is not connected to the tunnel.'); }
    else if (snapshot.linkDegraded) { setStatus('Not responding', 'warn'); }
    else { applyAccess(); say(''); }
    ['fanSlider', 'angleSlider', 'zeroSensors', 'zeroMotor', 'stopSweep'].forEach((id) => { $(id).disabled = !snapshot.connected; });
}

function connect() {
    clearTimeout(reconnectTimer);
    const code = $('code').value.trim() || storedCode();
    if (!code) { $('loginMessage').textContent = 'Enter the access code.'; return; }
    wantConnected = true;
    setStatus('Connecting', 'warn');
    socket = new WebSocket(`ws://${location.host}/ws`);
    const current = socket;
    current.addEventListener('open', () => current.send(JSON.stringify({ type: 'hello', code, name: navigator.userAgent.slice(0, 40) })));
    current.addEventListener('message', (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch (_error) { return; }
        if (message.type === 'denied') {
            wantConnected = false;
            try { sessionStorage.removeItem('wt-code'); } catch (_error) { /* nothing stored */ }
            $('loginMessage').textContent = message.error || 'Access denied.';
            setStatus('Access denied', 'bad');
            show('loginCard', true);
            return;
        }
        if (message.type === 'welcome') { storeCode(code); access = message.access; render(message.state); $('loginMessage').textContent = ''; return; }
        if (message.type === 'state') { access = message.access; render(message.state); return; }
        if (message.type === 'result') {
            const entry = pending.get(message.id);
            pending.delete(message.id);
            if (!message.ok) say(message.error || 'Command refused.');
            if (entry) entry(message);
        }
    });
    current.addEventListener('close', () => {
        if (socket !== current) return;
        socket = null;
        pending.clear();
        if (wantConnected) { setStatus('Reconnecting', 'warn'); reconnectTimer = setTimeout(connect, 3000); }
        else setStatus('Not connected');
    });
}

function send(name, args = []) {
    if (!socket || socket.readyState !== WebSocket.OPEN) { say('Not connected.'); return; }
    const id = nextId;
    nextId += 1;
    pending.set(id, () => {});
    socket.send(JSON.stringify({ type: 'cmd', id, name, args }));
}

$('connect').addEventListener('click', connect);
$('code').addEventListener('keydown', (event) => { if (event.key === 'Enter') connect(); });
$('disconnect').addEventListener('click', () => {
    wantConnected = false;
    try { sessionStorage.removeItem('wt-code'); } catch (_error) { /* nothing stored */ }
    if (socket) socket.close();
    show('liveCard', false); show('controlCard', false); show('disconnect', false); show('loginCard', true);
    say('');
});

// Commit on release, not on every input event, like the desktop app.
[['fanSlider', 'fanOut', 'setFanSpeed'], ['angleSlider', 'angleOut', 'setAngle']].forEach(([sliderId, outId, command]) => {
    const slider = $(sliderId);
    slider.addEventListener('pointerdown', () => { dragging = sliderId; });
    slider.addEventListener('pointerup', () => setTimeout(() => { if (dragging === sliderId) dragging = null; }, 300));
    slider.addEventListener('input', () => { $(outId).textContent = slider.value; });
    slider.addEventListener('change', () => send(command, [Number(slider.value)]));
});
$('zeroSensors').addEventListener('click', () => send('zeroSensors'));
$('zeroMotor').addEventListener('click', () => send('zeroMotor'));
$('stopSweep').addEventListener('click', () => send('stopSweep'));

if (storedCode()) { $('code').value = storedCode(); connect(); }
