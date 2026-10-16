const $ = (id) => document.getElementById(id);
const format = (value, digits = 2) => Number(value || 0).toFixed(digits);

const CUSTOM_AXIS_FIELDS = ['time', 'fanSpeed', 'angle', 'lift', 'drag', 'pressure', 'velocity'];
const SWEEP_FIELD_DEFAULTS = {
    angle: { start: -20, end: 45, step: 5, delay: 5 },
    fan: { start: 0, end: 60, step: 10, delay: 5 }
};

const state = {
    experiments: [],
    dragShapes: [],
    currentExperiment: null,
    liveSamples: [],
    experimentHistory: [],
    connected: false,
    simulation: false,
    sweepRunning: false
};

function log(message, level = 'info') {
    const row = document.createElement('div');
    row.textContent = `${new Date().toLocaleTimeString()}  ${level.toUpperCase()}  ${message}`;
    $('log').prepend(row);
}

function renderMetrics(sensors, connected) {
    $('metrics').innerHTML = [
        ['LIFT', sensors.lift, 'mN'], ['DRAG', sensors.drag, 'mN'], ['PRESSURE', sensors.pressure, 'Pa'], ['AIR SPEED', sensors.velocity, 'm/s']
    ].map(([name, value, unit]) => `<div class="metric"><div class="metric-name">${name}</div><div class="metric-value">${connected ? format(value) : '—'}</div><div class="metric-unit">${unit}</div><div class="metric-accent"></div></div>`).join('');
}

function renderCharts() {
    if (!state.currentExperiment) return;
    const liveSeries = state.liveSamples.slice(-60);
    const historySeries = state.experimentHistory.slice(-300);
    WindTunnelCharts.updateLive(liveSeries, state.currentExperiment);
    WindTunnelCharts.updateHistory(historySeries, state.currentExperiment);
    $('historyEmpty').classList.toggle('hidden', historySeries.length > 0);
}

function setView(view) {
    document.querySelectorAll('.view').forEach((el) => el.classList.add('hidden'));
    $(`${view}View`).classList.remove('hidden');
    document.querySelectorAll('.sidebar-link').forEach((el) => el.classList.toggle('active', el.dataset.view === view));
    $('viewTitle').textContent = view === 'control' ? 'Wind Tunnel Control' : view === 'calibrator' ? 'Wind Tunnel Calibrator' : 'Administration';
    $('sidebar').classList.add('-translate-x-full');
    $('sidebarBackdrop').classList.add('hidden');
    if (view === 'calibrator') { refreshScalers(); refreshLut(); }
    if (view === 'admin') { refreshDiagnostics(); refreshAudit(); }
}

function applyExperiment(experiment) {
    state.currentExperiment = experiment;
    $('liveChartTitle').textContent = experiment.title;
    const fields = experiment.fields || [];
    $('tappingFields').classList.toggle('hidden', !fields.includes('tapping'));
    $('dragShapeField').classList.toggle('hidden', !fields.includes('dragShape'));
    $('customAxesFields').classList.toggle('hidden', !fields.includes('customAxes'));
    $('traceSelectionField').classList.toggle('hidden', !fields.includes('traceSelection'));
    $('sweepFields').classList.toggle('hidden', !experiment.sweepType);
    $('sweepButtons').classList.toggle('hidden', !experiment.sweepType);
    if (experiment.sweepType) {
        const defaults = SWEEP_FIELD_DEFAULTS[experiment.sweepType];
        $('sweepStart').value = defaults.start;
        $('sweepEnd').value = defaults.end;
        $('sweepStep').value = defaults.step;
        $('sweepDelay').value = defaults.delay;
    }
    state.liveSamples = [];
    state.experimentHistory = [];
    WindTunnelCharts.configureForExperiment(experiment);
    renderCharts();
}

async function loadExperiments(selectedId) {
    const { experiments, dragShapes } = await window.windTunnel.listExperiments();
    state.experiments = experiments;
    state.dragShapes = dragShapes;
    $('experimentSelect').innerHTML = experiments.map((experiment) => `<option value="${experiment.id}">${experiment.title}</option>`).join('');
    $('dragShapeSelect').innerHTML = dragShapes.map((shape) => `<option value="${shape}">${shape}</option>`).join('');
    $('customXSelect').innerHTML = CUSTOM_AXIS_FIELDS.map((field) => `<option value="${field}">${field}</option>`).join('');
    $('customYSelect').innerHTML = CUSTOM_AXIS_FIELDS.map((field) => `<option value="${field}">${field}</option>`).join('');
    const experiment = experiments.find((item) => item.id === selectedId) || experiments[0];
    $('experimentSelect').value = experiment.id;
    applyExperiment(experiment);
}

function render(value) {
    state.connected = value.connected;
    state.simulation = value.simulation;
    state.sweepRunning = value.sweep.running;

    $('connectionBadge').textContent = value.connected ? (value.simulation ? 'Simulation mode' : 'Controller connected') : 'Searching for controller…';
    $('connectionBadge').className = `badge badge-sm gap-1 font-bold tracking-wider uppercase ${value.connected ? 'badge-success' : 'badge-warning'}`;
    $('portText').textContent = value.connected ? `${value.port} · API ${value.apiVersion}` : 'USB · VID 12BF / PID F010';
    $('connectButton').textContent = value.connected ? 'Disconnect' : 'Scan USB';

    $('adminConnectionPill').textContent = value.connected ? 'Connected' : 'Searching';
    $('adminConnectionPill').className = `badge ${value.connected ? 'badge-success' : 'badge-warning'}`;
    $('adminTransport').textContent = value.connected ? `${value.simulation ? 'Simulation' : 'USB serial'} · ${value.port}` : 'USB serial · waiting';
    $('adminRetries').textContent = value.diagnostics.retries;
    $('adminErrors').textContent = value.diagnostics.errors;

    $('adminStatus').textContent = value.adminUnlocked ? 'Unlocked' : 'Locked';
    $('unlockAdmin').textContent = value.adminUnlocked ? 'Lock Admin' : 'Unlock Admin';
    $('calibratorLockStatus').textContent = value.adminUnlocked ? 'Unlocked' : 'Locked';
    $('unlockCalibrator').textContent = value.adminUnlocked ? 'Admin unlocked' : 'Unlock';

    $('fanSlider').value = value.fanSpeed;
    $('angleSlider').value = value.angle;
    $('fanValue').textContent = `${value.fanSpeed}%`;
    $('angleValue').textContent = `${value.angle}°`;
    renderMetrics(value.sensors, value.connected);

    $('sweepStatePill').textContent = value.sweep.running ? `Sweeping (${value.sweep.current})` : 'Ready';
    $('sweepStatePill').className = `badge ${value.sweep.running ? 'badge-primary' : 'badge-accent'}`;
    $('startSweep').disabled = value.sweep.running;
    $('stopSweep').disabled = !value.sweep.running;

    $('logStatus').textContent = value.logging.active ? `Logging to ${value.logging.path} (${value.logging.rowCount} rows)` : 'Logging idle.';
    $('startLog').disabled = value.logging.active;
    $('stopLog').disabled = !value.logging.active;

    if (value.connected && state.currentExperiment) {
        state.liveSamples.push({ ...value.sensors, fanSpeed: value.fanSpeed, angle: value.angle });
        if (value.sweep.running) state.experimentHistory.push({ ...value.sensors, fanSpeed: value.fanSpeed, angle: value.angle });
    }
    renderCharts();
    $('lastUpdate').textContent = `Last update: ${new Date().toLocaleTimeString()}`;
}

function setView_bindNav() {
    document.querySelectorAll('.sidebar-link').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); setView(link.dataset.view); }));
}

$('sidebarToggle').addEventListener('click', () => { $('sidebar').classList.remove('-translate-x-full'); $('sidebarBackdrop').classList.remove('hidden'); });
$('sidebarClose').addEventListener('click', () => { $('sidebar').classList.add('-translate-x-full'); $('sidebarBackdrop').classList.add('hidden'); });
$('sidebarBackdrop').addEventListener('click', () => { $('sidebar').classList.add('-translate-x-full'); $('sidebarBackdrop').classList.add('hidden'); });

$('themeSelect').value = localStorage.getItem('wind-tunnel-theme') || 'dark';
document.documentElement.setAttribute('data-theme', $('themeSelect').value);
$('themeSelect').addEventListener('change', (event) => {
    document.documentElement.setAttribute('data-theme', event.target.value);
    localStorage.setItem('wind-tunnel-theme', event.target.value);
    log(`Theme changed to ${event.target.value}`);
});

$('connectButton').addEventListener('click', async () => {
    if (state.connected) { await window.windTunnel.disconnect(); log('Controller disconnected; fan command set to zero'); return; }
    try {
        const ports = await window.windTunnel.listPorts();
        if (ports.length) {
            const selected = window.prompt(`Available USB ports:\n${ports.map((port) => port.path).join('\n')}\n\nEnter port path:`, ports[0].path);
            if (selected) { await window.windTunnel.connectPort(selected, 115200); log(`Connected to ${selected} at 115200 baud`); return; }
        }
        log('No matching Wind Tunnel controller found; continuing USB scan', 'warning');
    } catch (error) { log(`USB scan failed: ${error.message}`, 'error'); }
});

$('fanSlider').addEventListener('change', async (event) => { await window.windTunnel.setFanSpeed(event.target.value); log(`Fan speed set to ${event.target.value}%`); });
$('angleSlider').addEventListener('change', async (event) => { await window.windTunnel.setAngle(event.target.value); log(`Motor angle set to ${event.target.value}°`); });
$('zeroSensors').addEventListener('click', async () => { const result = await window.windTunnel.zeroSensors(); log(result.message); });
$('zeroMotor').addEventListener('click', async () => { await window.windTunnel.zeroMotor(); log('Motor zero command acknowledged'); });

$('experimentSelect').addEventListener('change', async (event) => {
    await window.windTunnel.selectExperiment(event.target.value);
    applyExperiment(state.experiments.find((experiment) => experiment.id === event.target.value));
});
$('tappingChannel').addEventListener('change', (event) => window.windTunnel.setTapping(Number(event.target.value), Number($('tappingIncrement').value)));
$('tappingIncrement').addEventListener('change', (event) => window.windTunnel.setTapping(Number($('tappingChannel').value), Number(event.target.value)));
$('dragShapeSelect').addEventListener('change', (event) => window.windTunnel.setDragShape(event.target.value));
$('customXSelect').addEventListener('change', (event) => window.windTunnel.setCustomAxes(event.target.value, $('customYSelect').value));
$('customYSelect').addEventListener('change', (event) => window.windTunnel.setCustomAxes($('customXSelect').value, event.target.value));

$('startSweep').addEventListener('click', async () => {
    const options = { start: Number($('sweepStart').value), end: Number($('sweepEnd').value), step: Number($('sweepStep').value), delay: Number($('sweepDelay').value) * 1000 };
    const result = state.currentExperiment.sweepType === 'angle' ? await window.windTunnel.startAngleSweep(options) : await window.windTunnel.startFanSweep(options);
    log(result.ok ? `${state.currentExperiment.sweepType === 'angle' ? 'Angle' : 'Fan'} sweep started` : result.message, result.ok ? 'info' : 'error');
});
$('stopSweep').addEventListener('click', async () => { await window.windTunnel.stopSweep(); log('Sweep stopped'); });
$('startLog').addEventListener('click', async () => { const result = await window.windTunnel.startLog(); log(result.ok ? `Logging started: ${result.path}` : 'Failed to start logging', result.ok ? 'info' : 'error'); });
$('stopLog').addEventListener('click', async () => { const result = await window.windTunnel.stopLog(); log(`Logging stopped; ${result.rowCount} rows written`); });
$('clearChart').addEventListener('click', () => { state.experimentHistory.length = 0; renderCharts(); log('Experiment history cleared'); });
$('clearLog').addEventListener('click', () => { $('log').innerHTML = ''; });

async function unlockAdmin() {
    const password = window.prompt('Enter Admin password');
    if (!password) return false;
    const status = await window.windTunnel.adminStatus();
    const result = status.configured ? await window.windTunnel.verifyAdmin(password) : await window.windTunnel.setupAdmin(password);
    if (result.ok) { log('Admin session unlocked'); return true; }
    log(result.needsSetup ? 'Admin setup required' : 'Admin password rejected', 'error');
    return false;
}
$('unlockAdmin').addEventListener('click', async () => {
    const status = await window.windTunnel.adminStatus();
    if (status.unlocked) { await window.windTunnel.lockAdmin(); log('Admin session locked'); }
    else await unlockAdmin();
});
$('unlockCalibrator').addEventListener('click', async () => {
    const status = await window.windTunnel.adminStatus();
    if (!status.unlocked) await unlockAdmin();
});

async function refreshScalers() {
    try {
        const scalers = await window.windTunnel.getScalers();
        $('liftScaler').value = scalers.lift;
        $('dragScaler').value = scalers.drag;
        $('pressureScaler').value = scalers.pressure;
    } catch (error) { log(`Could not read scalers: ${error.message}`, 'error'); }
}
$('refreshScalers').addEventListener('click', refreshScalers);
document.querySelectorAll('.calibration').forEach((button) => button.addEventListener('click', async () => {
    const channel = Number(button.dataset.scaler);
    const inputId = ['liftScaler', 'dragScaler', 'pressureScaler'][channel];
    const modeId = ['liftMode', 'dragMode', 'pressureMode'][channel];
    const result = await window.windTunnel.setScaler(channel, Number($(modeId).value), Number($(inputId).value));
    if (result.ok) $(inputId).value = result.newValue;
    $('scalerAck').textContent = result.message;
    log(result.message, result.ok ? 'info' : 'error');
}));
$('calibrateDisplayBtn').addEventListener('click', async () => { const result = await window.windTunnel.calibrateDisplay(); $('scalerAck').textContent = result.message; log(result.message, result.ok ? 'info' : 'error'); });

async function refreshLut() {
    try {
        const entries = await window.windTunnel.getLut();
        $('lut').innerHTML = entries.map((value, index) => `
            <label>Fan ${(index + 1) * 10}%
                <input type="number" step="0.01" id="lutInput${index}" value="${value}">
                <button class="btn btn-ghost btn-xs lut-save" data-index="${index}">Save</button>
            </label>`).join('');
        document.querySelectorAll('.lut-save').forEach((button) => button.addEventListener('click', async () => {
            const index = Number(button.dataset.index);
            const result = await window.windTunnel.setLutEntry(index, Number($(`lutInput${index}`).value));
            if (result.ok) $(`lutInput${index}`).value = result.newValue;
            $('lutAck').textContent = result.message;
            log(result.message, result.ok ? 'info' : 'error');
        }));
    } catch (error) { log(`Could not read velocity LUT: ${error.message}`, 'error'); }
}
$('refreshLut').addEventListener('click', refreshLut);

$('saveNetwork').addEventListener('click', async () => {
    const [ip0, ip1, ip2, ip3] = $('networkIp').value.split('.').map((part) => Number(part) || 0);
    const result = await window.windTunnel.setNetwork(ip0, ip1, ip2, ip3, Number($('networkPort').value));
    $('networkAck').textContent = result.message;
    log(result.message, result.ok ? 'info' : 'error');
});

$('hexFile').addEventListener('change', (event) => { state.hexPath = event.target.files[0]?.path || null; });
document.querySelectorAll('.firmware-action').forEach((button) => button.addEventListener('click', async () => {
    const result = await window.windTunnel.firmware(button.dataset.action, state.hexPath);
    log(result.message, 'error');
}));
window.windTunnel.onFirmwareProgress((entry) => {
    const row = document.createElement('div');
    row.textContent = `[${entry.stage}] ${entry.message}`;
    row.className = entry.level === 'error' ? 'log-error' : entry.level === 'warn' ? 'log-warning' : 'log-info';
    $('firmwareLog').prepend(row);
});

async function refreshDiagnostics() {
    const diagnostics = await window.windTunnel.getDiagnostics();
    $('diagnostics').textContent = JSON.stringify(diagnostics, null, 2);
}
$('refreshDiagnostics').addEventListener('click', async () => { await refreshDiagnostics(); log('Diagnostics refreshed'); });

function renderAudit(entries) {
    $('auditLog').innerHTML = entries.slice().reverse().map((entry) => `<div>${entry.timestamp}  [${entry.source}]  ${entry.command}  ${entry.result}</div>`).join('');
}
async function refreshAudit() { renderAudit(await window.windTunnel.getAuditLog()); }
$('refreshAudit').addEventListener('click', refreshAudit);
window.windTunnel.onAuditUpdate(renderAudit);
window.windTunnel.onLogEvent((event) => { $('logStatus').textContent = `Logging to ${event.path} (${event.rowCount} rows)`; });

$('updateButton').addEventListener('click', () => log('No signed application update service configured yet'));

setView_bindNav();
window.windTunnel.onState(render);
window.windTunnel.getState().then(async (value) => {
    WindTunnelCharts.createCharts();
    await loadExperiments(value.experimentId);
    render(value);
    log(value.simulation ? 'Wind Tunnel UI ready; explicit simulation mode active' : 'Wind Tunnel UI ready; searching for USB controller');
});
setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }, 1000);
