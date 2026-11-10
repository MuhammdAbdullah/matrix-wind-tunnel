const $ = (id) => document.getElementById(id);
const format = (value, digits = 2) => Number(value || 0).toFixed(digits);

const CUSTOM_AXIS_FIELDS = ['time', 'fanSpeed', 'angle', 'lift', 'drag', 'pressure', 'velocity'];
const CUSTOM_AXIS_LABELS = { time: 'Time', fanSpeed: 'Fan Speed', angle: 'Angle', lift: 'Lift', drag: 'Drag', pressure: 'Pressure', velocity: 'Velocity' };
const SWEEP_FIELD_DEFAULTS = {
    angle: { start: -20, end: 45, step: 5, delay: 5 },
    fan: { start: 0, end: 60, step: 10, delay: 5 }
};

// Live chart window: rolling buffer of the most recent samples, labelled with the real
// wall-clock time each sample was taken rather than a sample index.
const MAX_LIVE_SAMPLES = 60;

const state = {
    experiments: [],
    dragShapes: [],
    currentExperiment: null,
    liveSamples: [],
    experimentHistory: [],
    historyRuns: [], // one entry per sweep run, for sweepType experiments only -- see buildSweepRunLabel
    customAxes: { x: 'time', y: 'lift' },
    traceVisibility: { lift: true, drag: true, pressure: false }, // Sensors vs Time only; chart display, never logged -- defaults match legacy's ShowLift=1/ShowDrag=1/ShowPressure=0
    liveWindow: MAX_LIVE_SAMPLES, // mirrors 'liveWindowSelect': a point count, or Infinity for "All data"
    lastDeviceState: null,
    connected: false,
    simulation: false,
    sweepRunning: false,
    sweepWasRunning: false,
    lastSensorSampleSeq: null,
    lastLoggedPointSeq: null
};

// Legacy's GraphPlot mechanism re-plots each new sweep as its own trace on top of the
// previous ones (so repeated angle sweeps at different fan speeds stay visually distinct)
// instead of overwriting/connecting into one line, and wraps back to the first trace once
// its 8-trace limit is hit. We mirror that by starting a new labelled "run" each time a
// sweep starts, and dropping the oldest run once the dataset count would exceed 8.
const MAX_SWEEP_TRACES = 8;

function buildSweepRunLabel(experiment, value) {
    // The run label always describes what's held constant across the WHOLE sweep (not
    // whatever the Stem Racing chart-type selector currently maps to the x-axis), so it stays
    // meaningful regardless of which of the three chart-type display options is selected.
    if (experiment.sweepType === 'angle') return `${value.fanSpeed}% Fan`;
    if (experiment.sweepType === 'fan') return `${value.angle}° Angle`;
    return '';
}

// Stem Racing's "Chart Type" property (legacy: StemRacingChartType) relabels the SAME fan
// sweep's x-axis as Time / Air Speed / Fan Speed -- it never changes what's actually swept.
function sweepXValue(experiment, value, pointIndex) {
    if (experiment.id === 'stemRacing') {
        if (value.stemRacingChartType === 1) return value.sensors.velocity; // vs Air Speed
        if (value.stemRacingChartType === 2) return value.fanSpeed; // vs Fan Speed
        return pointIndex * (value.sweep.delay / 1000); // vs Time (elapsed seconds)
    }
    if (experiment.sweepType === 'angle') return value.angle;
    if (experiment.sweepType === 'fan') return value.fanSpeed;
    return pointIndex;
}

// Splits manualLog history into separate chart "runs", the way sweeps already get one run per
// sweep (see MAX_SWEEP_TRACES/buildSweepRunLabel above). A new run starts when the operator
// redoes the experiment -- the tapping channel / cylinder angle wraps back to the start, or the
// fan speed (or the aerofoil's angle) changes -- so the second pass gets its own colour instead
// of a straight line joining the end of the last run back to the start of this one.
function startsNewManualRun(experiment, prev, point) {
    if (!prev) return true;
    if (point.fanSpeed !== prev.fanSpeed) return true;
    if (experiment.id === 'pressureTappedAerofoil') return point.tappingChannel < prev.tappingChannel || point.aerofoilAngle !== prev.aerofoilAngle;
    if (experiment.id === 'pressureTappedCylinder') return point.angle < prev.angle;
    return false;
}

function manualRunLabel(experiment, point, number) {
    const base = `Run ${number}: ${point.fanSpeed}% fan`;
    return experiment.id === 'pressureTappedAerofoil' ? `${base}, ${point.aerofoilAngle}°` : base;
}

function groupManualLogHistory(experiment, points) {
    const runs = [];
    let prev = null;
    points.forEach((point) => {
        if (startsNewManualRun(experiment, prev, point)) runs.push({ label: manualRunLabel(experiment, point, runs.length + 1), points: [] });
        runs[runs.length - 1].points.push({ x: point[experiment.xField], sensors: point });
        prev = point;
    });
    return runs.length > MAX_SWEEP_TRACES ? runs.slice(-MAX_SWEEP_TRACES) : runs;
}

function stemRacingXLabel(chartType) {
    if (chartType === 1) return 'Air Speed (m/s)';
    if (chartType === 2) return 'Fan Speed (%)';
    return 'Time (s)';
}

// Both display concerns below are renderer-only (chart filtering/labelling), matching the
// legacy source where ShowLift/ShowDrag/ShowPressure and StemRacingChartType only affect what
// the SCADA panel displays, never the logged CSV columns -- so neither touches `experiment`
// itself (used for CSV/sweep logic), only the clone passed into the chart-drawing functions.
function chartExperiment(experiment) {
    if (!experiment) return experiment;
    const value = state.lastDeviceState || {};
    let liveTraces = experiment.liveTraces;
    let secondaryTraces = experiment.secondaryTraces;
    let xLabel = experiment.xLabel;
    if (experiment.id === 'sensorsVsTime') {
        liveTraces = liveTraces.filter((trace) => state.traceVisibility[trace] !== false);
        secondaryTraces = (secondaryTraces || []).filter((trace) => liveTraces.includes(trace));
    }
    if (experiment.id === 'stemRacing') {
        xLabel = stemRacingXLabel(value.stemRacingChartType ?? 1);
    }
    return { ...experiment, liveTraces, secondaryTraces, xLabel };
}

function log(message, level = 'info') {
    const row = document.createElement('div');
    row.textContent = `${new Date().toLocaleTimeString()}  ${level.toUpperCase()}  ${message}`;
    $('log').prepend(row);
}

function renderMetrics(sensors, connected) {
    $('metrics').innerHTML = [
        ['LIFT', sensors.lift, 'mN'], ['DRAG', sensors.drag, 'mN'], ['PRESSURE', sensors.pressure, 'Pa'], ['AIR SPEED', sensors.velocity, 'm/s']
    ].map(([name, value, unit]) => `<div class="metric"><div class="metric-name">${name} (${unit})</div><div class="metric-value">${connected ? format(value) : '—'}</div></div>`).join('');
}

// Legacy ShowHideCharts() only ever shows one chart at a time: Chart_Historic acts as the
// continuous live time trace for Sensors vs Time (the only experiment without an XY axis of
// its own), and Chart_XY -- the experiment-specific accumulated plot -- for every other
// experiment, including sweep-type ones. Mirror that one-chart-at-a-time rule here instead
// of always showing both liveChart and historyChart side by side.
function updateChartVisibility(experiment) {
    const showLive = experiment.id === 'sensorsVsTime';
    $('liveChartPanel').classList.toggle('chart-hidden', !showLive);
    $('historyChartPanel').classList.toggle('chart-hidden', showLive);
}

const RUN_GROUPED_EXPERIMENTS = ['pressureTappedCylinder', 'pressureTappedAerofoil'];

function renderCharts() {
    if (!state.currentExperiment) return;
    const experiment = chartExperiment(state.currentExperiment);
    const liveSeries = Number.isFinite(state.liveWindow) ? state.liveSamples.slice(-state.liveWindow) : state.liveSamples;
    WindTunnelCharts.updateLive(liveSeries, experiment, state.customAxes);

    if (state.currentExperiment.sweepType) {
        WindTunnelCharts.updateHistoryRuns(state.historyRuns, experiment);
        const pointCount = state.historyRuns.reduce((sum, run) => sum + run.points.length, 0);
        $('historyCount').textContent = pointCount > 0 ? `${pointCount} pts across ${state.historyRuns.length} sweep(s)` : 'No logged points yet';
        return;
    }
    if (RUN_GROUPED_EXPERIMENTS.includes(state.currentExperiment.id)) {
        const historySeries = state.experimentHistory.slice(-2000);
        const runs = groupManualLogHistory(state.currentExperiment, historySeries);
        WindTunnelCharts.updateHistoryRuns(runs, experiment);
        const pointCount = runs.reduce((sum, run) => sum + run.points.length, 0);
        $('historyCount').textContent = pointCount > 0 ? `${pointCount} pts across ${runs.length} run(s)` : 'No logged points yet';
        return;
    }
    const historySeries = state.experimentHistory.slice(-300);
    WindTunnelCharts.updateHistory(historySeries, experiment, state.customAxes);
    $('historyCount').textContent = historySeries.length > 0 ? `${historySeries.length} pts` : 'No logged points yet';
}

const isMobileViewport = () => window.matchMedia('(max-width: 767px)').matches;

function closeSidebar() {
    $('sidebar').classList.add('sidebar-closed');
    $('sidebarBackdrop').classList.add('hidden');
}

function setView(view) {
    document.querySelectorAll('.view').forEach((el) => el.classList.add('hidden'));
    $(`${view}View`).classList.remove('hidden');
    document.querySelectorAll('.sidebar-link').forEach((el) => el.classList.toggle('active', el.dataset.view === view));
    if (isMobileViewport()) closeSidebar();
    if (view === 'admin') { refreshDiagnostics(); refreshAudit(); }
}

function switchAdminTab(tabName) {
    document.querySelectorAll('.admin-tabs .tab-button').forEach((button) => button.classList.toggle('active', button.dataset.adminTab === tabName));
    document.querySelectorAll('#adminView > .tab-content').forEach((pane) => pane.classList.toggle('active', pane.id === `${tabName}Tab`));
    if (tabName === 'calibrator') { refreshScalers({ keepReadings: true }); refreshLut(); }
    if (tabName === 'network') refreshNetworkSettings();
}

function applyExperiment(experiment) {
    state.currentExperiment = experiment;
    $('liveChartTitle').textContent = experiment.id === 'custom' ? WindTunnelCharts.customTitle(state.customAxes) : experiment.title;
    $('historyChartTitle').textContent = experiment.id === 'custom' ? WindTunnelCharts.customTitle(state.customAxes) : experiment.title;
    updateChartVisibility(experiment);
    const fields = experiment.fields || [];
    $('tappingFields').classList.toggle('hidden', !fields.includes('tapping'));
    $('manualAngleField').classList.toggle('hidden', !fields.includes('manualAngle'));
    $('dragShapeField').classList.toggle('hidden', !fields.includes('dragShape'));
    $('fanSpeedIncrementField').classList.toggle('hidden', !fields.includes('fanSpeedIncrement'));
    $('customAxesFields').classList.toggle('hidden', !fields.includes('customAxes'));
    $('stemRacingChartTypeField').classList.toggle('hidden', !fields.includes('stemRacingChartType'));
    $('traceVisibilityField').classList.toggle('hidden', !fields.includes('traceVisibility'));
    $('sweepFields').classList.toggle('hidden', !experiment.sweepType);
    $('sweepButtons').classList.toggle('hidden', !experiment.sweepType);
    // Sweep-driven experiments log via Start/Stop sweep; the standalone log
    // buttons are only needed for the no-sweep experiments.
    $('logButtons').classList.toggle('hidden', !!experiment.sweepType);
    // manualLog experiments capture one point per click (mirroring the legacy source's
    // single "Log" button) instead of the continuous sensor-sample timer.
    $('logPointButtonRow').classList.toggle('hidden', !experiment.manualLog);
    if (experiment.sweepType) {
        const defaults = SWEEP_FIELD_DEFAULTS[experiment.sweepType];
        $('sweepStart').value = defaults.start;
        $('sweepEnd').value = defaults.end;
        $('sweepStep').value = defaults.step;
        $('sweepDelay').value = defaults.delay;
    }
    state.liveSamples = [];
    state.experimentHistory = [];
    state.historyRuns = [];
    WindTunnelCharts.configureForExperiment(chartExperiment(experiment), state.customAxes);
    renderCharts();
}

async function loadExperiments(selectedId) {
    const { experiments, dragShapes } = await window.windTunnel.listExperiments();
    state.experiments = experiments;
    state.dragShapes = dragShapes;
    $('experimentSelect').innerHTML = experiments.map((experiment) => `<option value="${experiment.id}">${experiment.title}</option>`).join('');
    $('dragShapeSelect').innerHTML = dragShapes.map((shape) => `<option value="${shape}">${shape}</option>`).join('');
    $('customXSelect').innerHTML = CUSTOM_AXIS_FIELDS.map((field) => `<option value="${field}">${CUSTOM_AXIS_LABELS[field]}</option>`).join('');
    $('customYSelect').innerHTML = CUSTOM_AXIS_FIELDS.map((field) => `<option value="${field}">${CUSTOM_AXIS_LABELS[field]}</option>`).join('');
    const experiment = experiments.find((item) => item.id === selectedId) || experiments[0];
    $('experimentSelect').value = experiment.id;
    applyExperiment(experiment);
}

// Admin -> Network: the last pushed state (for the controller card and Apply) and whether the edit fields hold unsent input.
let lastNetworkValue = null;
let networkFieldsDirty = false;
let shownControllerReadAt = null;

// Admin -> Bootloader: Trigger Bootloader is only usable while the application link is up. After a
// successful trigger it stays grey until the link has dropped and come back (see noteHardwareState()).
let hardwareOnline = false;
let triggerPending = false;
let triggerSawOffline = false;
let triggerPendingTimer = null;
let bootloaderButtonState = 'disconnected';

function render(value) {
    const stemRacingChartTypeChanged = state.lastDeviceState && state.lastDeviceState.stemRacingChartType !== value.stemRacingChartType;
    state.lastDeviceState = value;
    followMaster(value);
    noteHardwareState(value.connected && !value.simulation && value.transport !== 'remote');
    state.connected = value.connected;
    state.simulation = value.simulation;
    state.sweepRunning = value.sweep.running;
    updateLutLive(value);
    updateScalerLive(value);
    if (scalerReadFailed && value.connected && !value.linkDegraded && !scalerBusy && !scalerRefresh) {
        refreshScalers({ keepReadings: true });
    }

    const customAxesChanged = value.customAxes && (value.customAxes.x !== state.customAxes.x || value.customAxes.y !== state.customAxes.y);
    if (value.customAxes) state.customAxes = value.customAxes;
    if (customAxesChanged && state.currentExperiment && state.currentExperiment.id === 'custom') {
        $('liveChartTitle').textContent = WindTunnelCharts.customTitle(state.customAxes);
        $('historyChartTitle').textContent = WindTunnelCharts.customTitle(state.customAxes);
        WindTunnelCharts.configureForExperiment(chartExperiment(state.currentExperiment), state.customAxes);
    }
    // The Chart Type selector only relabels the x-axis (sweepXValue reads it per point
    // already) -- rebuild the axis title immediately rather than waiting for the next tick.
    if (stemRacingChartTypeChanged && state.currentExperiment && state.currentExperiment.id === 'stemRacing') {
        WindTunnelCharts.configureForExperiment(chartExperiment(state.currentExperiment), state.customAxes);
    }

    // linkDegraded: connected but the controller has been silent for a few seconds (the watchdog drops
    // the link if it stays silent). connecting: a port is open and awaiting the version reply.
    const degraded = value.connected && value.linkDegraded;
    const badgeTone = degraded || (value.connecting && !value.connected) ? 'badge-warning' : value.connected ? 'badge-success' : 'badge-error';
    const remoteMode = value.transport === 'remote';
    const remoteLabel = value.remoteAccess === 'control' ? 'REMOTE · CONTROL' : 'REMOTE · VIEW ONLY';
    $('connectionBadge').textContent = degraded ? 'NOT RESPONDING' : value.connected ? (value.simulation ? 'SIMULATION MODE' : remoteMode ? remoteLabel : 'SYSTEM ONLINE') : value.connecting ? 'CONNECTING' : remoteMode ? 'REMOTE · OFFLINE' : 'SYSTEM OFFLINE';
    $('connectionBadge').className = `badge badge-sm gap-1 font-bold tracking-wider uppercase ${badgeTone}`;

    $('adminConnectionPill').textContent = degraded ? 'Not responding' : value.connected ? 'Connected' : value.connecting ? 'Connecting' : 'Searching';
    $('adminConnectionPill').className = `badge ${badgeTone}`;
    $('adminTransport').textContent = value.connected ? `${value.simulation ? 'Simulation' : TRANSPORT_LABELS[value.transport] || 'USB serial'} · ${value.port}` : remoteMode ? 'Remote · reconnecting' : 'USB serial · waiting';
    renderNetworkStatus(value);
    $('adminRetries').textContent = value.diagnostics.retries;
    $('adminErrors').textContent = value.diagnostics.errors;

    // Don't overwrite a slider the operator is mid-drag on: main only learns the new value on
    // release ('change'), so every sensor-tick publish during the drag carries the old value
    // and would snap the thumb back.
    if (!draggingSliders.has('fanSlider')) $('fanSlider').value = value.fanSpeed;
    if (!draggingSliders.has('angleSlider')) $('angleSlider').value = value.angle;
    if (document.activeElement !== $('fanValue')) $('fanValue').value = value.fanSpeed;
    if (document.activeElement !== $('angleValue')) $('angleValue').value = value.angle;
    renderMetrics(value.sensors, value.connected);

    // Log Point auto-advances the tapping channel by the increment in main (legacy
    // OnLogButtonClick), so show the channel/increment main actually holds.
    if (document.activeElement !== $('tappingChannel')) $('tappingChannel').value = value.tapping.channel;
    if (document.activeElement !== $('aerofoilAngle')) $('aerofoilAngle').value = value.aerofoilAngle;

    const rgbToHex = ({ r, g, b }) => `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
    if (document.activeElement !== $('ledAnimMode')) $('ledAnimMode').value = value.leds.animMode;
    if (document.activeElement !== $('ledAnimColor')) $('ledAnimColor').value = rgbToHex(value.leds.animColor);
    if (document.activeElement !== $('ledAmbMode')) $('ledAmbMode').value = value.leds.ambMode;
    if (document.activeElement !== $('ledAmbColor')) $('ledAmbColor').value = rgbToHex(value.leds.ambColor);

    $('sweepStatePill').textContent = value.sweep.running ? `Sweeping (${value.sweep.current})` : '';
    $('sweepStatePill').classList.toggle('pill-active', value.sweep.running);
    $('sweepStatePill').classList.toggle('badge-pulse', value.sweep.running);
    $('startSweep').disabled = value.sweep.running;
    $('stopSweep').disabled = !value.sweep.running;

    $('logStatus').textContent = value.logging.active ? `Logging to ${value.logging.path} (${value.logging.rowCount} rows)` : 'Logging idle.';
    $('startLog').disabled = value.logging.active;
    $('stopLog').disabled = !value.logging.active;
    applyRemoteRestrictions(value);

    // Sweep experiments keep their CSV open between sweeps but record nothing while idle, and
    // their "Sweeping (n)" pill already covers the recording period -- so the "Logging" pill
    // is only for experiments where an open log means points are being (or can be) captured.
    const showLogPill = value.logging.active && !value.sweep.running && !(state.currentExperiment && state.currentExperiment.sweepType);
    $('logStatePill').classList.toggle('pill-active', showLogPill);
    $('logStatePill').classList.toggle('badge-pulse', showLogPill);

    // A publish only carries a genuinely new sensor reading when value.sensorSampleSeq
    // has moved on from the last one we recorded -- any other publish (fan/angle slider
    // commit, LED write, experiment/tapping/drag-shape change, a retry-exhausted
    // setAngle/setFanSpeed error, etc.) still reaches render() but must not log another
    // chart point off the same still-stale sensor values. See state.js's sensorSampleSeq
    // comment. Compared once per render() call, not per branch below.
    // sensorSampleSeq === 0 means no reading has arrived yet (sensors are still the 0 defaults),
    // so the very first publish after launch must not be charted as a real point.
    const freshSample = value.sensorSampleSeq > 0 && value.sensorSampleSeq !== state.lastSensorSampleSeq;
    if (value.connected && state.currentExperiment) {
        if (freshSample) state.liveSamples.push({ ...value.sensors, fanSpeed: value.fanSpeed, angle: value.angle, time: Date.now() });
        if (state.currentExperiment.sweepType) {
            const joinedMidSweep = value.transport === 'remote' && value.sweep.running && !state.historyRuns.length;
            if (value.sweep.running && (!state.sweepWasRunning || joinedMidSweep)) {
                // This publish is the sweep-start transition itself, fired before the motor has
                // moved to the start angle (sweeps.js's startSweep() publishes before its first
                // tick() runs) -- only open the run here. Recording a point now would use stale
                // angle/sensor data instead of the real start-angle reading, giving the chart a
                // spurious leading point ahead of the configured sweep start.
                state.historyRuns.push({ label: buildSweepRunLabel(state.currentExperiment, value), points: [] });
                const tracesPerRun = (state.currentExperiment.liveTraces || []).length || 1;
                const maxRuns = Math.max(1, Math.floor(MAX_SWEEP_TRACES / tracesPerRun));
                if (state.historyRuns.length > maxRuns) state.historyRuns = state.historyRuns.slice(-maxRuns);
            } else if (value.sweep.running && state.historyRuns.length && freshSample) {
                const run = state.historyRuns[state.historyRuns.length - 1];
                run.points.push({ x: sweepXValue(state.currentExperiment, value, run.points.length), sensors: value.sensors });
            }
        } else if (state.currentExperiment.manualLog) {
            // manualLog experiments (pressureToVelocity, pressureTappedCylinder,
            // pressureTappedAerofoil, dragCoefficient, custom) have no sweep -- the legacy
            // source's "Log" button adds exactly one chart point per click instead of
            // plotting the continuous sensor stream. loggedPointSeq/lastLoggedPoint (bumped by
            // main/sweeps.js's logPoint(), fired by the Log Point button) tell us a new point
            // was actually captured, as opposed to an unrelated publish.
            const freshLoggedPoint = value.loggedPointSeq !== state.lastLoggedPointSeq;
            if (freshLoggedPoint && state.lastLoggedPointSeq !== null && value.lastLoggedPoint) state.experimentHistory.push({ ...value.lastLoggedPoint });
        }
    }
    state.lastSensorSampleSeq = value.sensorSampleSeq;
    state.lastLoggedPointSeq = value.loggedPointSeq;
    state.sweepWasRunning = value.sweep.running;
    renderCharts();
    $('lastUpdate').textContent = `Last update: ${new Date().toLocaleTimeString()}`;
}

function setView_bindNav() {
    document.querySelectorAll('.sidebar-link').forEach((link) => link.addEventListener('click', async (event) => {
        event.preventDefault();
        const view = link.dataset.view;
        if (view === 'admin') {
            const status = await window.windTunnel.adminStatus();
            if (!status.unlocked) {
                const unlocked = await unlockAdmin();
                if (!unlocked) return;
            }
        }
        setView(view);
    }));
    document.querySelectorAll('.admin-tabs .tab-button').forEach((button) => button.addEventListener('click', () => switchAdminTab(button.dataset.adminTab)));
}

$('sidebarToggle').addEventListener('click', () => {
    const nowHidden = $('sidebar').classList.toggle('sidebar-closed');
    if (!nowHidden && isMobileViewport()) $('sidebarBackdrop').classList.remove('hidden');
    else $('sidebarBackdrop').classList.add('hidden');
});
$('sidebarClose').addEventListener('click', closeSidebar);
$('sidebarBackdrop').addEventListener('click', closeSidebar);

if (!isMobileViewport()) $('sidebar').classList.remove('sidebar-closed');

function applyThemeLogo(theme) {
    $('matrixLogo').src = theme === 'light' ? '../assets/Matrix 2024 Balck.png' : '../assets/Matrix 2024 White.png';
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    applyThemeLogo(theme);
    $('themeIconDark').classList.toggle('hidden', theme === 'light');
    $('themeIconLight').classList.toggle('hidden', theme !== 'light');
    $('themeToggle').setAttribute('aria-pressed', String(theme === 'light'));
    localStorage.setItem('wind-tunnel-theme', theme);
    WindTunnelCharts.updateTheme();
}

applyTheme(localStorage.getItem('wind-tunnel-theme') || 'dark');
$('themeToggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    applyTheme(next);
    log(`Theme changed to ${next}`);
});

$('forceDisconnect')?.addEventListener('click', async () => {
    await window.windTunnel.disconnect();
    log('Controller disconnected from Admin; fan command set to zero, USB auto-scan continues');
});

// Track sliders being dragged (pointer held, or keyboard-focused until 'change' fires) so
// render() leaves them alone until the new value has been committed to main.
const draggingSliders = new Set();
['fanSlider', 'angleSlider'].forEach((id) => {
    const slider = $(id);
    slider.addEventListener('pointerdown', () => draggingSliders.add(id));
    slider.addEventListener('pointerup', () => setTimeout(() => draggingSliders.delete(id), 300));
    slider.addEventListener('pointercancel', () => draggingSliders.delete(id));
    slider.addEventListener('blur', () => draggingSliders.delete(id));
});
// Live-update the numeric box while dragging.
$('fanSlider').addEventListener('input', (event) => { $('fanValue').value = event.target.value; });
$('angleSlider').addEventListener('input', (event) => { $('angleValue').value = event.target.value; });

$('fanSlider').addEventListener('change', async (event) => { await window.windTunnel.setFanSpeed(event.target.value); log(`Fan speed set to ${event.target.value}%`); });
$('angleSlider').addEventListener('change', async (event) => { await window.windTunnel.setAngle(event.target.value); log(`Motor angle set to ${event.target.value}°`); });

$('fanValue').addEventListener('change', async (event) => {
    const clamped = Math.min(100, Math.max(0, Math.round(Number(event.target.value) || 0)));
    event.target.value = clamped;
    $('fanSlider').value = clamped;
    await window.windTunnel.setFanSpeed(clamped);
    log(`Fan speed set to ${clamped}%`);
});
$('fanValue').addEventListener('keydown', (event) => { if (event.key === 'Enter') event.target.blur(); });

$('angleValue').addEventListener('change', async (event) => {
    const clamped = Math.min(180, Math.max(-180, Math.round(Number(event.target.value) || 0)));
    event.target.value = clamped;
    $('angleSlider').value = clamped;
    await window.windTunnel.setAngle(clamped);
    log(`Motor angle set to ${clamped}°`);
});
$('angleValue').addEventListener('keydown', (event) => { if (event.key === 'Enter') event.target.blur(); });

// Typeable boxes: select the whole number on focus so typing replaces it, and let the stacked
// chevrons nudge it by 1 (Shift = 10) through the same `change` handlers as typing.
['fanValue', 'angleValue'].forEach((id) => $(id).addEventListener('focus', (event) => event.target.select()));
document.querySelectorAll('.step-btn').forEach((button) => {
    button.addEventListener('mousedown', (event) => event.preventDefault()); // keep focus where it was
    button.addEventListener('click', (event) => {
        const input = $(button.dataset.stepTarget);
        if (input.disabled) return;
        const step = Number(button.dataset.step) * (event.shiftKey ? 10 : 1);
        const next = Math.min(Number(input.max), Math.max(Number(input.min), Math.round(Number(input.value) || 0) + step));
        if (String(next) === input.value) return;
        input.value = next;
        input.dispatchEvent(new Event('change'));
    });
});
$('zeroSensors').addEventListener('click', async () => { const result = await window.windTunnel.zeroSensors(); log(result.message); });
$('zeroMotor').addEventListener('click', async () => { await window.windTunnel.zeroMotor(); log('Motor zero command acknowledged'); });

function hexToRgb(hex) {
    const value = hex.replace('#', '');
    return { r: parseInt(value.substring(0, 2), 16), g: parseInt(value.substring(2, 4), 16), b: parseInt(value.substring(4, 6), 16) };
}

async function sendLeds() {
    await window.windTunnel.setLeds({
        animMode: Number($('ledAnimMode').value),
        animColor: hexToRgb($('ledAnimColor').value),
        ambMode: Number($('ledAmbMode').value),
        ambColor: hexToRgb($('ledAmbColor').value)
    });
    log('LED configuration sent');
}

$('ledAnimMode').addEventListener('change', sendLeds);
$('ledAnimColor').addEventListener('change', sendLeds);
$('ledAmbMode').addEventListener('change', sendLeds);
$('ledAmbColor').addEventListener('change', sendLeds);

$('experimentSelect').addEventListener('change', async (event) => {
    await window.windTunnel.selectExperiment(event.target.value);
    applyExperiment(state.experiments.find((experiment) => experiment.id === event.target.value));
});
$('tappingChannel').addEventListener('change', (event) => window.windTunnel.setTapping(Number(event.target.value)));
$('aerofoilAngle').addEventListener('change', async (event) => {
    const clamped = Math.min(45, Math.max(-45, Math.round(Number(event.target.value) || 0)));
    event.target.value = clamped;
    await window.windTunnel.setAerofoilAngle(clamped);
    log(`Aerofoil angle set to ${clamped}°`);
});
$('manualAngleIncrementSelect').addEventListener('change', (event) => window.windTunnel.setManualAngleIncrement(Number(event.target.value)));
$('dragShapeSelect').addEventListener('change', (event) => window.windTunnel.setDragShape(event.target.value));
$('fanSpeedIncrementSelect').addEventListener('change', (event) => window.windTunnel.setFanSpeedIncrement(Number(event.target.value)));
$('stemRacingChartTypeSelect').addEventListener('change', (event) => window.windTunnel.setStemRacingChartType(Number(event.target.value)));

// Renderer-only display toggle (not sent to main -- never affects CSV logging, matching
// legacy's ShowLift/ShowDrag/ShowPressure, which only ever controlled chart visibility).
function onTraceVisibilityChange(trace, checked) {
    state.traceVisibility[trace] = checked;
    WindTunnelCharts.configureForExperiment(chartExperiment(state.currentExperiment), state.customAxes);
    renderCharts();
}
$('traceVisLift').addEventListener('change', (event) => onTraceVisibilityChange('lift', event.target.checked));
$('traceVisDrag').addEventListener('change', (event) => onTraceVisibilityChange('drag', event.target.checked));
$('traceVisPressure').addEventListener('change', (event) => onTraceVisibilityChange('pressure', event.target.checked));
$('customXSelect').addEventListener('change', (event) => window.windTunnel.setCustomAxes(event.target.value, $('customYSelect').value));
$('customYSelect').addEventListener('change', (event) => window.windTunnel.setCustomAxes($('customXSelect').value, event.target.value));

// Angle sweeps: the motor's travel time to the start angle is not reported back by the controller,
// so the operator confirms the arrival. Resolves true on OK, false on cancel.
function confirmMotorAtStart(angle) {
    return new Promise((resolve) => {
        const modal = $('sweepStartModal');
        const form = $('sweepStartForm');
        $('sweepStartModalAngle').textContent = angle;
        modal.classList.add('modal-open');
        $('sweepStartOk').focus();
        const done = (result) => {
            form.removeEventListener('submit', onSubmit);
            $('sweepStartCancel').removeEventListener('click', onCancel);
            $('sweepStartBackdrop').removeEventListener('click', onCancel);
            modal.classList.remove('modal-open');
            resolve(result);
        };
        const onCancel = () => done(false);
        const onSubmit = (event) => { event.preventDefault(); done(true); };
        form.addEventListener('submit', onSubmit);
        $('sweepStartCancel').addEventListener('click', onCancel);
        $('sweepStartBackdrop').addEventListener('click', onCancel);
    });
}

$('startSweep').addEventListener('click', async () => {
    const options = { start: Number($('sweepStart').value), end: Number($('sweepEnd').value), step: Number($('sweepStep').value), delay: Number($('sweepDelay').value) * 1000 };
    if (state.currentExperiment.sweepType === 'angle') {
        const startAngle = Math.min(180, Math.max(-180, Math.round(options.start) || 0));
        const moved = await window.windTunnel.setAngle(startAngle);
        if (moved && moved.ok === false) { log(moved.message || 'Could not move the motor to the start angle', 'error'); return; }
        log(`Motor moving to sweep start angle ${startAngle}°`);
        if (!await confirmMotorAtStart(startAngle)) { log('Sweep cancelled'); return; }
        options.startReady = true;
    }
    const result =state.currentExperiment.sweepType === 'angle' ? await window.windTunnel.startAngleSweep(options) : await window.windTunnel.startFanSweep(options);
    if (result.canceled) { log(result.message); return; }
    log(result.ok ? `${state.currentExperiment.sweepType === 'angle' ? 'Angle' : 'Fan'} sweep started` : result.message, result.ok ? 'info' : 'error');
});
$('stopSweep').addEventListener('click', async () => { await window.windTunnel.stopSweep(); log('Sweep stopped'); });
$('startLog').addEventListener('click', async () => {
    const result = await window.windTunnel.startLog();
    if (result.canceled) { log('Save location cancelled; logging not started'); return; }
    log(result.ok ? `Logging started: ${result.path}` : 'Failed to start logging', result.ok ? 'info' : 'error');
});
$('stopLog').addEventListener('click', async () => { const result = await window.windTunnel.stopLog(); log(`Logging stopped; ${result.rowCount} rows written`); });
// A new aerofoil test begins at tapping channel 1, so ask for the aerofoil's angle there --
// the angle is typed in by hand, and this stops it being forgotten. Resolves to the angle, or
// null if the operator cancels (the point is then not logged).
function askAerofoilAngle() {
    return new Promise((resolve) => {
        const modal = $('aerofoilAngleModal');
        const form = $('aerofoilAngleForm');
        const input = $('aerofoilAngleDialogInput');
        input.value = (state.lastDeviceState && state.lastDeviceState.aerofoilAngle) || 0;
        modal.classList.add('modal-open');
        input.focus();
        input.select();
        const done = (result) => {
            form.removeEventListener('submit', onSubmit);
            $('aerofoilAngleCancel').removeEventListener('click', onCancel);
            $('aerofoilAngleBackdrop').removeEventListener('click', onCancel);
            modal.classList.remove('modal-open');
            resolve(result);
        };
        const onCancel = () => done(null);
        const onSubmit = (event) => {
            event.preventDefault();
            done(Math.min(45, Math.max(-45, Math.round(Number(input.value) || 0))));
        };
        form.addEventListener('submit', onSubmit);
        $('aerofoilAngleCancel').addEventListener('click', onCancel);
        $('aerofoilAngleBackdrop').addEventListener('click', onCancel);
    });
}

$('logPointButton').addEventListener('click', async () => {
    const device = state.lastDeviceState;
    if (state.currentExperiment && state.currentExperiment.id === 'pressureTappedAerofoil' && device && device.tapping.channel === 1) {
        const angle = await askAerofoilAngle();
        if (angle === null) return;
        await window.windTunnel.setAerofoilAngle(angle);
        log(`Aerofoil angle set to ${angle}°`);
    }
    const result = await window.windTunnel.logPoint();
    log(result.ok ? 'Point logged' : 'Failed to log point', result.ok ? 'info' : 'error');
});
$('clearChart').addEventListener('click', () => {
    state.experimentHistory.length = 0;
    state.historyRuns.length = 0;
    renderCharts();
    log('Experiment history cleared');
});
$('clearLiveChart').addEventListener('click', () => {
    state.liveSamples.length = 0;
    renderCharts();
    log('Live chart cleared');
});
$('liveWindowSelect').addEventListener('change', (event) => {
    state.liveWindow = event.target.value === 'all' ? Infinity : MAX_LIVE_SAMPLES;
    renderCharts();
});
$('clearLog').addEventListener('click', () => { $('log').innerHTML = ''; });

// Every password box gets a show/hide eye and a Caps Lock warning. Caps Lock state is only readable from a
// key event, so the warning appears on the first key pressed in the box and clears on blur.
const EYE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
const passwordFields = [];

function setPasswordRevealed(field, revealed) {
    field.input.type = revealed ? 'text' : 'password';
    field.toggle.innerHTML = revealed ? EYE_OFF_ICON : EYE_ICON;
    field.toggle.setAttribute('aria-label', revealed ? 'Hide password' : 'Show password');
    field.toggle.setAttribute('aria-pressed', String(revealed));
}

function resetPasswordFields() {
    passwordFields.forEach((field) => { setPasswordRevealed(field, false); field.caps.classList.add('hidden'); });
}

document.querySelectorAll('input[type="password"]').forEach((input) => {
    const wrap = document.createElement('div');
    wrap.className = 'password-field';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'password-toggle';
    wrap.appendChild(toggle);

    const caps = document.createElement('p');
    caps.className = 'caps-warning hidden';
    caps.textContent = 'Caps Lock is on';
    wrap.insertAdjacentElement('afterend', caps);

    const field = { input, toggle, caps };
    passwordFields.push(field);
    setPasswordRevealed(field, false);
    toggle.addEventListener('click', () => { setPasswordRevealed(field, input.type === 'password'); input.focus(); });
    const checkCaps = (event) => {
        if (typeof event.getModifierState === 'function') caps.classList.toggle('hidden', !event.getModifierState('CapsLock'));
    };
    input.addEventListener('keydown', checkCaps);
    input.addEventListener('keyup', checkCaps);
    input.addEventListener('blur', () => caps.classList.add('hidden'));
});

function openAdminPasswordModal() {
    resetPasswordFields();
    $('adminPasswordError').classList.add('hidden');
    $('adminPasswordInput').value = '';
    $('adminPasswordModal').classList.add('modal-open');
    $('adminPasswordInput').focus();
}
function closeAdminPasswordModal() {
    $('adminPasswordModal').classList.remove('modal-open');
}
async function unlockAdmin() {
    return new Promise((resolve) => {
        openAdminPasswordModal();
        const form = $('adminPasswordForm');
        const cancelBtn = $('adminPasswordCancel');
        const backdropBtn = $('adminPasswordBackdrop');
        const cleanup = () => {
            form.removeEventListener('submit', onSubmit);
            cancelBtn.removeEventListener('click', onCancel);
            backdropBtn.removeEventListener('click', onCancel);
        };
        const onCancel = () => { cleanup(); closeAdminPasswordModal(); resolve(false); };
        const onSubmit = async (event) => {
            event.preventDefault();
            const password = $('adminPasswordInput').value;
            if (!password) return;
            const status = await window.windTunnel.adminStatus();
            const result = status.configured ? await window.windTunnel.verifyAdmin(password) : await window.windTunnel.setupAdmin(password);
            if (result.ok) {
                cleanup();
                closeAdminPasswordModal();
                log('Admin session unlocked');
                resolve(true);
                return;
            }
            $('adminPasswordError').textContent = result.needsSetup ? 'Admin setup required.'
                : result.unreadable ? 'Admin password file cannot be read (wrong Windows user or damaged). Delete wind-tunnel-admin.json in the app data folder to reset to the initial password.'
                : (result.message || 'Incorrect password.');
            $('adminPasswordError').classList.remove('hidden');
            $('adminPasswordInput').value = '';
            $('adminPasswordInput').focus();
            log(result.needsSetup ? 'Admin setup required' : 'Admin password rejected', 'error');
        };
        form.addEventListener('submit', onSubmit);
        cancelBtn.addEventListener('click', onCancel);
        backdropBtn.addEventListener('click', onCancel);
    });
}

$('changePasswordForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = $('changePasswordMessage');
    const show = (text, ok) => {
        message.textContent = text;
        message.classList.toggle('text-error', !ok);
        message.classList.toggle('text-success', ok);
        message.classList.remove('hidden');
    };
    const current = $('currentPasswordInput').value;
    const next = $('newPasswordInput').value;
    if (!current || !next) { show('Enter the current and new password.', false); return; }
    if (next !== $('confirmPasswordInput').value) { show('New password and confirmation do not match.', false); return; }
    if (!(await ensureAdminUnlocked())) { show('Admin session is locked - nothing was changed.', false); return; }
    const result = await window.windTunnel.changeAdminPassword(current, next);
    if (!result.ok) {
        show(result.unreadable ? 'Admin password file cannot be read.' : (result.message || 'Password was not changed.'), false);
        log('Admin password change rejected', 'error');
        return;
    }
    ['currentPasswordInput', 'newPasswordInput', 'confirmPasswordInput'].forEach((id) => { $(id).value = ''; });
    show('Admin password changed.', true);
    log('Admin password changed');
});

// The Admin session lapses after 30 minutes while this view stays open; ask for the password again
// rather than letting the next calibration action fail with only a faint message.
async function ensureAdminUnlocked() {
    const status = await window.windTunnel.adminStatus();
    return status.unlocked || unlockAdmin();
}

const SCALER_INPUT_IDS = ['liftScaler', 'dragScaler', 'pressureScaler'];
const SCALER_MODE_IDS = ['liftMode', 'dragMode', 'pressureMode'];
let scalerBusy = false;
// What the controller currently holds for each channel. The sensor-reading helper scales this (the firmware
// shows (raw - zero) * scaler), so it must not read the scale factor box, which the helper itself overwrites.
const storedScalers = [null, null, null];
// True while the note shows a failed scaler read. render() re-reads once the controller is connected, so a
// read that failed because the link was still coming up does not leave a stale "not connected" message.
let scalerReadFailed = false;

// The note under the scalers. Failures are shown in the error colour at full strength: the default text is
// faint and small, so a "could not work out a factor" message was easy to miss.
function setScalerNote(text, isError = false) {
    const note = $('scalerAck');
    note.textContent = text;
    note.classList.toggle('text-error', isError);
    note.classList.toggle('opacity-60', !isError);
}

function setScalerBusy(busy) {
    scalerBusy = busy;
    document.querySelectorAll('.calibration, #refreshScalers, #scalerZero').forEach((button) => { button.disabled = busy; });
}

// A refresh that is still waiting on the controller (it queues behind sensor polling and the table read) is
// shared: a second caller waits for it instead of being refused, and a typed sensor reading waits for it too,
// because its completion rewrites the scale factor boxes.
let scalerRefresh = null;
function refreshScalers(options) {
    if (scalerRefresh) return scalerRefresh;
    if (scalerBusy) return Promise.resolve(false);
    scalerRefresh = loadScalers(options).finally(() => { scalerRefresh = null; });
    return scalerRefresh;
}
// Resolves true when the controller's scalers were read and the fields refreshed. A failed read leaves
// storedScalers empty (the boxes then only hold the page defaults) and says so on the page, not just in the log.
async function loadScalers({ keepReadings = false } = {}) {
    setScalerBusy(true);
    try {
        const scalers = await window.windTunnel.getScalers();
        $('liftScaler').value = scalers.lift;
        $('dragScaler').value = scalers.drag;
        $('pressureScaler').value = scalers.pressure;
        storedScalers[0] = scalers.lift;
        storedScalers[1] = scalers.drag;
        storedScalers[2] = scalers.pressure;
        if (!keepReadings) ['lift', 'drag', 'pressure'].forEach((name) => { $(`${name}Reading`).value = ''; });
        // The fields now hold absolute values, so a Relative mode left selected would square them on Save.
        SCALER_MODE_IDS.forEach((id) => { $(id).value = '0'; });
        // A "could not read" message from an earlier attempt no longer applies; leave any other note alone.
        if (scalerReadFailed) setScalerNote('Scalers read from the controller.');
        scalerReadFailed = false;
        return true;
    } catch (error) {
        storedScalers.fill(null);
        // Only a link that was down is retried automatically; any other failure waits for Refresh.
        scalerReadFailed = /not connected/i.test(error.message);
        const message = /not connected/i.test(error.message)
            ? 'The controller is not connected, so its current scalers cannot be read and a sensor reading cannot be turned into a scale factor. Connect the controller, then type the reading again (the boxes only show page defaults, not values from the controller).'
            : `Could not read the scalers from the controller: ${error.message}. The boxes below are not the controller's values - press Refresh.`;
        setScalerNote(message, true);
        log(message, 'error');
        return false;
    } finally { setScalerBusy(false); }
}
$('refreshScalers').addEventListener('click', () => refreshScalers());
$('scalerZero').addEventListener('click', async () => {
    if (scalerBusy) return;
    setScalerBusy(true);
    try {
        const result = await window.windTunnel.zeroSensors();
        setScalerNote(result.message, !result.ok);
        log(result.message, result.ok ? 'info' : 'error');
    } catch (error) {
        const message = `Zero sensors failed: ${error.message}`;
        setScalerNote(message, true);
        log(message, 'error');
    } finally { setScalerBusy(false); }
});
// The operator types what the sensor is reading; the scale factor box is filled with the new absolute scaler,
// stored scaler * numerator / reading (numerator 4905 for lift and drag, 1000 for pressure), because the
// reading already includes the stored scaler. Nothing changes until a positive number is typed, and nothing
// reaches the controller until Save (in Absolute mode). The stored scaler is read on demand when the tab's
// own refresh did not succeed, and every case where no factor can be worked out is explained on the page:
// a silent no-op looks exactly like "the scale factor does not change". A negative stored scaler (an inverted
// sensor) keeps its sign.
async function applyScalerReading(name, channel) {
    const input = $(`${name}Reading`);
    const valid = () => input.value !== '' && Number.isFinite(Number(input.value)) && Number(input.value) > 0;
    if (!valid()) return;
    if (scalerRefresh) await scalerRefresh;
    if (!Number.isFinite(storedScalers[channel])) {
        if (scalerBusy) { setScalerNote('Another calibration action is still running - type the reading again when it has finished.', true); return; }
        if (!(await refreshScalers({ keepReadings: true }))) return;
    }
    if (!valid()) return; // edited or cleared while the controller was being read
    const stored = storedScalers[channel];
    const fail = (text) => setScalerNote(text, true);
    if (!Number.isFinite(stored) || stored === 0) {
        fail(`The controller holds a ${name} scaler of ${stored}, so a sensor reading cannot be turned into a scale factor. Type the scale factor directly and press Save.`);
        return;
    }
    const scaler = stored * Number(input.dataset.numerator) / Number(input.value);
    if (Math.abs(scaler) > 1e6) {
        fail(`That ${name} reading gives a scale factor of ${scaler.toExponential(2)}, outside the usable range. Check the value you typed.`);
        return;
    }
    $(`${name}Scaler`).value = scaler.toFixed(6);
    $(SCALER_MODE_IDS[channel]).value = '0';
}
['lift', 'drag', 'pressure'].forEach((name, channel) => {
    $(`${name}Reading`).addEventListener('input', () => applyScalerReading(name, channel));
});
document.querySelectorAll('.calibration').forEach((button) => button.addEventListener('click', async () => {
    if (scalerBusy) return;
    const channel = Number(button.dataset.scaler);
    const inputId = SCALER_INPUT_IDS[channel];
    const modeId = SCALER_MODE_IDS[channel];
    // The raw text goes to the main process, which validates it: Number('') would silently be 0 here.
    setScalerBusy(true);
    try {
        if (!(await ensureAdminUnlocked())) { setScalerNote('Admin session is locked - nothing was written.', true); return; }
        const mode = Number($(modeId).value);
        const result = await window.windTunnel.setScaler(channel, mode, $(inputId).value);
        if (result.ok) {
            // Absolute: keep the value the operator typed (the controller confirmed it within tolerance), so a
            // float32 read-back such as 1.0000001 never replaces a plain 1. Relative: the field must show the
            // resulting absolute scaler. Leave the mode on Absolute so pressing Save again cannot multiply
            // a Relative factor in a second time.
            $(inputId).value = mode === 0 ? result.sentValue : result.newValue;
            $(modeId).value = '0';
            storedScalers[channel] = result.newValue;
            $(`${['lift', 'drag', 'pressure'][channel]}Reading`).value = '';
        }
        setScalerNote(result.message, !result.ok);
        log(result.message, result.ok ? 'info' : 'error');
    } catch (error) {
        const message = `Scaler write failed: ${error.message}`;
        setScalerNote(message, true);
        log(message, 'error');
    } finally { setScalerBusy(false); }
}));

// Velocity lookup table. Each fan step's velocity is derived from a recorded pressure with
// V = sqrt(2*|dP| / rho) (CP0704 Worksheet 1, rho = 1.20 kg/m3). Pressure is only a working value
// in this table -- the controller stores just the ten velocities, written together by "Save Table".
const AIR_DENSITY = 1.20;
const LUT_STEPS = 10;
let lutBusy = false;
let lutDirty = false; // unsaved pressure/velocity entries that a re-read from the controller would discard

function pressureToVelocity(pressure) {
    return Math.sqrt((2 * Math.abs(pressure)) / AIR_DENSITY);
}

function formatVelocity(velocity) {
    return Number.isFinite(velocity) ? String(Number(velocity.toFixed(2))) : '';
}

function renderLut(entries) {
    lutDirty = false;
    $('lut').innerHTML = entries.map((value, index) => `
        <tr class="lut-row" data-index="${index}">
            <td><button type="button" class="lut-step" data-index="${index}" title="Set the fan to ${(index + 1) * 10}%">Fan ${(index + 1) * 10}%</button></td>
            <td><input type="number" step="any" class="input input-bordered input-sm lut-pressure" id="lutPressure${index}" data-index="${index}"></td>
            <td><input type="number" step="0.01" min="0" class="input input-bordered input-sm lut-velocity" id="lutVelocity${index}" value="${formatVelocity(value)}"></td>        </tr>`).join('');
    updateLutChart();
}

// Plots the velocity column (y) against the fan steps 10..100 % (x), so it follows typed pressures,
// hand-typed velocities, a Refresh and a confirmed Save alike.
function updateLutChart() {
    const velocities = Array.from({ length: LUT_STEPS }, (_unused, index) => {
        const raw = $(`lutVelocity${index}`)?.value;
        return raw === undefined || raw === '' ? NaN : Number(raw);
    });
    WindTunnelCharts.updateLutChart(velocities);
}

function setLutActive(index) {
    document.querySelectorAll('.lut-row').forEach((row) => row.classList.toggle('lut-active', Number(row.dataset.index) === index));
}

function lutMessage(message, ok = true) {
    $('lutAck').textContent = message;
    $('lutAck').classList.toggle('text-error', !ok);
    log(message, ok ? 'info' : 'error');
}

async function setLutFan(percent) {
    const result = await window.windTunnel.setLutFan(percent);
    lutMessage(result.message, result.ok);
    return result.ok;
}

async function selectLutStep(index) {
    const ok = await setLutFan((index + 1) * 10);
    if (ok) setLutActive(index);
    return ok;
}

// Enter in a row's pressure box: the typed pressure is already converted to velocity by the input
// handler, so just move the fan to the next 10% step -- or stop it after 100%.
async function advanceLutStep(index) {
    if (index < LUT_STEPS - 1) {
        if (await selectLutStep(index + 1)) $(`lutPressure${index + 1}`).focus();
        return;
    }
    if (await setLutFan(0)) {
        setLutActive(null);
        lutMessage('Fan stopped. Check the table, then press Save Table to send it to the controller.');
    }
}

const LUT_ACTION_BUTTONS = '.lut-step, #lutStart, #lutStop, #lutZero, #saveLut';

// Runs one fan/sensor action at a time so a double-click cannot interleave two of them.
async function runLutAction(action, { needsAdmin = true } = {}) {
    if (lutBusy) return;
    lutBusy = true;
    document.querySelectorAll(LUT_ACTION_BUTTONS).forEach((button) => { button.disabled = true; });
    try {
        if (needsAdmin && !(await ensureAdminUnlocked())) { lutMessage('Admin session is locked - unlock it to continue.', false); return; }
        await action();
    }
    catch (error) { lutMessage(`Velocity table action failed: ${error.message}`, false); }
    finally {
        lutBusy = false;
        document.querySelectorAll(LUT_ACTION_BUTTONS).forEach((button) => { button.disabled = false; });
    }
}

// `manual` is the Refresh button; opening the tab only re-reads when nothing unsaved would be lost.
async function refreshLut({ manual = false } = {}) {
    if (lutBusy) return;
    if (lutDirty && (!manual || !confirm('Re-read the table from the controller? Unsaved pressure and velocity entries will be lost.'))) return;
    try {
        const entries = await window.windTunnel.getLut();
        renderLut(entries);
    } catch (error) { log(`Could not read velocity LUT: ${error.message}`, 'error'); }
}

// Live sensor readings beside each scaler, so a scaler can be judged against the sensor as it is changed.
// Dashes until a real reading has arrived (sensors are 0 defaults before that) or while disconnected.
function updateScalerLive(value) {
    const live = value.connected && value.sensorSampleSeq > 0 ? value.sensors : null;
    const show = (id, reading, decimals) => { $(id).textContent = live && Number.isFinite(reading) ? reading.toFixed(decimals) : '-'; };
    show('liftLive', live?.lift, 1);
    show('dragLive', live?.drag, 1);
    show('pressureLive', live?.pressure, 2);
}

function updateLutLive(value) {
    $('lutLivePressure').textContent = Number.isFinite(value.sensors?.pressure) ? value.sensors.pressure.toFixed(1) : '-';
    $('lutLiveFan').textContent = value.fanSpeed;
    // Green once the fan is running so Start capture is not pressed again (that would restart from 10%).
    const running = value.fanSpeed > 0;
    $('lutStart').classList.toggle('btn-success', running);
    $('lutStart').classList.toggle('btn-secondary', !running);
    $('lutStart').title = running ? 'Capture in progress - the fan is running' : '';
}

$('lut').addEventListener('input', (event) => {
    lutDirty = true;
    if (event.target.classList.contains('lut-pressure')) {
        const pressure = event.target.value === '' ? NaN : Number(event.target.value);
        if (Number.isFinite(pressure)) $(`lutVelocity${event.target.dataset.index}`).value = formatVelocity(pressureToVelocity(pressure));
    } else if (event.target.classList.contains('lut-velocity')) {
        // A hand-typed velocity no longer matches any recorded pressure, so drop the stale one.
        $(`lutPressure${event.target.id.replace('lutVelocity', '')}`).value = '';
    }
    updateLutChart();
});
$('lut').addEventListener('click', (event) => {
    const step = event.target.closest('.lut-step');
    if (step) runLutAction(() => selectLutStep(Number(step.dataset.index)));
});
$('lut').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !event.target.classList.contains('lut-pressure')) return;
    event.preventDefault();
    const index = Number(event.target.dataset.index);
    if (event.target.value === '' || !Number.isFinite(Number(event.target.value))) {
        lutMessage(`Type the pressure for Fan ${(index + 1) * 10}% first, then press Enter.`, false);
        return;
    }
    runLutAction(() => advanceLutStep(index));
});
$('lutZero').addEventListener('click', () => runLutAction(async () => {
    const result = await window.windTunnel.zeroSensors();
    lutMessage(result.message, result.ok);
}, { needsAdmin: false }));
$('lutStart').addEventListener('click', () => runLutAction(() => selectLutStep(0)));
$('lutStop').addEventListener('click', () => runLutAction(async () => { await setLutFan(0); setLutActive(null); }, { needsAdmin: false }));
$('saveLut').addEventListener('click', () => runLutAction(async () => {
    const velocities = Array.from({ length: LUT_STEPS }, (_unused, index) => {
        const raw = $(`lutVelocity${index}`).value;
        return raw === '' ? null : Number(raw);
    });
    const result = await window.windTunnel.setLutTable(velocities);
    lutMessage(result.message, result.acknowledged);
    // Only a controller-confirmed table replaces what was typed; on any failure the operator's values stay put.
    if (result.acknowledged) { result.entries.forEach((entry, index) => { $(`lutVelocity${index}`).value = formatVelocity(entry); }); lutDirty = false; updateLutChart(); }
}));
$('refreshLut').addEventListener('click', () => refreshLut({ manual: true }));
renderLut(Array(LUT_STEPS).fill(NaN));

const TRANSPORT_LABELS = { usb: 'USB serial', ethernet: 'Ethernet (WebSocket)', remote: 'Remote (via master PC)' };

// Remote clients never own the hardware: view-only ones cannot touch any control, and controllers
// still cannot start sweeps/logs (those run on the master). The master enforces this independently.
const REMOTE_CONTROL_IDS = ['fanSlider', 'angleSlider', 'fanValue', 'angleValue', 'zeroSensors', 'zeroMotor', 'ledAnimMode', 'ledAnimColor', 'ledAmbMode', 'ledAmbColor'];
// startSweep/startLog are re-enabled by render() itself, so they are only ever forced off here.
const REMOTE_FORCE_OFF_IDS = ['startSweep', 'startLog'];
// Experiment setup belongs to the master PC: a remote client shows it but cannot change it.
const REMOTE_MASTER_ONLY_IDS = ['logPointButton', 'experimentSelect', 'tappingChannel', 'aerofoilAngle', 'manualAngleIncrementSelect', 'dragShapeSelect', 'fanSpeedIncrementSelect', 'stemRacingChartTypeSelect', 'customXSelect', 'customYSelect', 'sweepStart', 'sweepEnd', 'sweepStep', 'sweepDelay'];

function applyRemoteRestrictions(value) {
    const remote = value.transport === 'remote';
    const viewOnly = remote && value.remoteAccess !== 'control';
    REMOTE_CONTROL_IDS.forEach((id) => { $(id).disabled = viewOnly; });
    if (remote) REMOTE_FORCE_OFF_IDS.forEach((id) => { $(id).disabled = true; });
    REMOTE_MASTER_ONLY_IDS.forEach((id) => { $(id).disabled = remote; });
    $('remoteExperimentNote').classList.toggle('hidden', !remote);
    $('stopSweep').title = remote ? 'Stops the sweep running on the master PC' : '';
    if (remote) $('stopSweep').disabled = viewOnly || !value.sweep.running;
}

// A remote client mirrors the master's experiment: it switches to the experiment the master selected,
// shows the master's settings and sweep range, and (through render()) plots each sweep and logged point.
function followMaster(value) {
    if (value.transport !== 'remote' || !state.experiments.length) return;
    if (value.experimentId && (!state.currentExperiment || state.currentExperiment.id !== value.experimentId)) {
        const experiment = state.experiments.find((item) => item.id === value.experimentId);
        if (experiment) { $('experimentSelect').value = experiment.id; applyExperiment(experiment); }
    }
    if (value.dragShape) $('dragShapeSelect').value = value.dragShape;
    if (value.manualAngle) $('manualAngleIncrementSelect').value = value.manualAngle.increment;
    $('fanSpeedIncrementSelect').value = value.fanSpeedIncrement;
    $('stemRacingChartTypeSelect').value = value.stemRacingChartType;
    if (value.customAxes) { $('customXSelect').value = value.customAxes.x; $('customYSelect').value = value.customAxes.y; }
    const sweep = value.sweep;
    if (state.currentExperiment && state.currentExperiment.sweepType && sweep.type === state.currentExperiment.sweepType) {
        $('sweepStart').value = sweep.start;
        $('sweepEnd').value = sweep.end;
        $('sweepStep').value = Math.abs(sweep.step);
        $('sweepDelay').value = sweep.delay / 1000;
    }
}

function setPill(id, text, tone) {
    $(id).textContent = text;
    $(id).className = `badge badge-${tone}`;
}

// One plain sentence about how this PC reaches the controller, plus the single next step if there is one.
// `action.target` is the id of the control that fixes it; the banner button opens its section and focuses it.
let netHeroAction = null;
let lastBlockedLogged = null;

function describeNetworkState(value) {
    const net = value.network || {};
    const info = net.controller && net.controller.supported ? net.controller : null;
    const where = info ? `Controller address ${info.ip} · port ${info.port} · MAC ${info.mac}` : '';
    const blocked = net.ethernetBlocked;
    const usb = value.transport === 'usb';
    if (value.simulation) return { tone: 'neutral', title: 'Simulation mode', detail: 'No real controller is connected; values are synthetic.' };
    if (value.transport === 'remote') {
        return value.connected
            ? { tone: 'success', title: 'Following another PC', detail: 'This app mirrors the PC that has the tunnel connected.' }
            : { tone: 'warning', title: 'Reconnecting to the other PC...', detail: 'The PC that has the tunnel is not answering right now.' };
    }
    if (value.connected && usb) {
        return { tone: 'success', title: 'Connected by USB cable', detail: where || 'USB is the most reliable link and takes priority over the network.' };
    }
    if (value.connected) return { tone: 'success', title: 'Connected over the network', detail: where || 'Using the network because no USB cable is plugged in.' };
    if (blocked && blocked.code === 'USB_IN_CONTROL') {
        return { tone: 'warning', title: 'Network paused: the controller is in use over USB', detail: 'Another app (here or on another PC) has the USB cable. This PC connects by itself when it is released.' };
    }
    if (blocked && (blocked.code === 'AUTH_FAILED' || blocked.code === 'AUTH_TIMEOUT')) {
        return { tone: 'error', title: 'The controller did not accept the connection', detail: 'It may still be closing the previous session; the app keeps retrying. If this stays, the controller may have a new IP address: read it on its touchscreen and enter it below.', action: { label: 'Enter IP address', target: 'ethHost' } };
    }
    if (value.connecting) return { tone: 'warning', title: 'Connecting...', detail: 'Checking the controller.' };
    const networkOn = $('ethEnabled').checked;
    if (!networkOn) return { tone: 'neutral', title: 'Not connected', detail: "Plug in the USB cable, or type the IP address from the controller's touchscreen below and press Connect.", action: { label: 'Enter IP address', target: 'ethHost' } };
    return { tone: 'neutral', title: 'Looking for the controller...', detail: "Plug in the USB cable, or check the IP address against the controller's touchscreen." };
}

function renderNetHero(value) {
    const state = describeNetworkState(value);
    $('netHero').dataset.tone = state.tone;
    $('netHeroTitle').textContent = state.title;
    $('netHeroDetail').textContent = state.detail;
    netHeroAction = state.action || null;
    $('netHeroAction').classList.toggle('hidden', !netHeroAction);
    if (netHeroAction) $('netHeroAction').textContent = netHeroAction.label;
}

$('netHeroAction').addEventListener('click', () => {
    if (!netHeroAction) return;
    const target = $(netHeroAction.target);
    const section = target.closest('details');
    if (section) section.open = true;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.focus({ preventScroll: true });
});

function renderNetworkStatus(value) {
    lastNetworkValue = value;
    renderControllerNetwork(value);
    renderNetHero(value);
    const net = value.network || {};
    const relay = net.relay || {};
    const remote = net.remote || {};
    const modeText = { off: 'Off', view: 'View only', control: 'View and control' }[relay.mode] || 'Off';
    $('adminRemoteAccess').textContent = relay.running ? `${modeText} · port ${relay.port} · ${relay.clients.length} device(s)` : modeText === 'Off' ? 'Off' : `${modeText} · not listening`;
    if (value.transport === 'remote') {
        const via = remote.hardwareTransport ? ` · tunnel on ${remote.hardwareTransport === 'ethernet' ? 'Ethernet' : 'USB'}` : '';
        setPill('netLinkPill', `Remote${via}`, value.connected ? 'success' : 'warning');
    } else {
        setPill('netLinkPill', value.connected ? ({ usb: 'USB', ethernet: 'Network' }[value.transport] || 'Connected') : 'Offline', value.connected ? 'success' : 'neutral');
    }
    setPill('relayPill', relay.running ? modeText : relay.mode && relay.mode !== 'off' ? 'Not listening' : 'Off', relay.running ? 'success' : relay.mode && relay.mode !== 'off' ? 'warning' : 'neutral');
    setPill('remotePill', value.transport === 'remote' ? (value.connected ? (value.remoteAccess === 'control' ? 'Connected · control' : 'Connected · view only') : 'Reconnecting') : 'Not connected', value.transport === 'remote' && value.connected ? 'success' : value.transport === 'remote' ? 'warning' : 'neutral');
    // Names come from other devices, so they are only ever inserted as text.
    const list = $('relayClients');
    list.replaceChildren(...(relay.clients || []).map((client) => {
        const row = document.createElement('div');
        row.textContent = `${client.name} · ${client.address} · ${client.commands} command(s)${client.lastCommandAt ? ` · last ${new Date(client.lastCommandAt).toLocaleTimeString()}` : ''}`;
        return row;
    }));
    if (!(relay.clients || []).length) list.textContent = 'No devices connected.';

    const yielded = net.ethernetYield;
    $('ethYield').classList.toggle('hidden', !yielded);
    const blocked = net.ethernetBlocked;
    // The status banner (describeNetworkState) explains a refusal in plain words; the raw message goes to the log only.
    $('ethBlocked').classList.add('hidden');
    if (blocked && blocked.at !== lastBlockedLogged) { lastBlockedLogged = blocked.at; log(blocked.message, 'error'); }
    if (yielded) $('ethYield').textContent = `Ethernet released: ${yielded.name} (${yielded.host}) has the controller over USB. Connect to it as a remote device below.`;
    const found = net.discovered || [];
    const foundList = $('discoveredMasters');
    if (!found.length) foundList.textContent = 'None found. A master appears here when another PC is connected to the tunnel with remote access on.';
    else {
        foundList.replaceChildren(...found.map((master) => {
            const row = document.createElement('div');
            const label = `${master.name} · ${master.host}:${master.port} · tunnel on ${master.hardware === 'usb' ? 'USB' : 'Ethernet'} · ${{ off: 'remote access off', view: 'view only', control: 'view and control' }[master.mode]}`;
            if (master.mode !== 'off') {
                const use = document.createElement('button');
                use.className = 'btn btn-xs btn-outline mr-2';
                use.textContent = 'Use';
                use.addEventListener('click', () => { $('remoteHost').value = master.host; $('remotePort').value = master.port; $('remoteCode').focus(); });
                row.append(use);
            }
            row.append(document.createTextNode(label));
            return row;
        }));
    }
}

// "address:port CODE" as shown on the master; pasting it into the client's address field fills all three inputs.
let shareText = '';
const SHARE_PATTERN = /^\s*([^\s:]+)(?::(\d{1,5}))?\s+([A-Za-z0-9]{4}-?[A-Za-z0-9]{4})\s*$/;

$('copyShare').addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(shareText);
        log('Connection details copied; paste them into Master address on the other PC');
    } catch (error) {
        log(`Could not copy: ${error.message}`, 'error');
    }
});

$('remoteHost').addEventListener('paste', (event) => {
    const match = SHARE_PATTERN.exec(event.clipboardData.getData('text'));
    if (!match) return;
    event.preventDefault();
    $('remoteHost').value = match[1];
    if (match[2]) $('remotePort').value = match[2];
    $('remoteCode').value = match[3];
});

async function refreshNetworkSettings() {
    const result = await window.windTunnel.getNetworkSettings();
    if (!result.ok) { log(result.message, 'error'); return; }
    // Do not clobber a field the operator is editing.
    const setIfIdle = (id, value) => { if (document.activeElement !== $(id)) $(id).value = value; };
    $('ethEnabled').checked = result.ethernet.enabled;
    setIfIdle('ethHost', result.ethernet.host);
    setIfIdle('ethPort', result.ethernet.port);
    $('relayMode').value = result.relay.mode;
    setIfIdle('relayPort', result.relay.port);
    $('relayCode').textContent = result.relay.accessCode;
    shareText = result.addresses.length ? `${result.addresses[0]}:${result.relay.port} ${result.relay.accessCode}` : '';
    $('relayShare').textContent = shareText || 'no network adapter found';
    $('copyShare').disabled = !shareText;
    setIfIdle('remoteHost', result.remote.host);
    setIfIdle('remotePort', result.remote.port);
    $('relayUrls').textContent = result.addresses.length ? result.addresses.map((address) => `http://${address}:${result.relay.port}`).join('   ') : 'no network adapter found';
    if (result.relayLastError) $('relayAck').textContent = result.relayLastError;
    if (lastNetworkValue && lastNetworkValue.connected && !(lastNetworkValue.network || {}).controller) refreshControllerInfo();
}

// ----- controller network identity ----------------------------------------------------

// The first three bytes are fixed (the W5500's own WIZnet block); only the last three are typed. Mirrors main/netinfo.js.
const MAC_OUI = '00:08:DC';
const MAC_SUFFIX_PATTERN = /^[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){2}$/;

function macSuffixProblem(text) {
    if (!MAC_SUFFIX_PATTERN.test(text)) return `Enter the last three bytes of the MAC address as three hex pairs, for example 12:34:56 (the first three bytes are fixed at ${MAC_OUI}).`;
    return null;
}

// The last three bytes of a controller-reported MAC, for the edit field.
function macSuffixOf(mac) {
    return String(mac || '').toUpperCase().split(/[:-]/).slice(3).join(':');
}

// Types the colons for the operator: hex digits only, upper case, a ":" after every second digit, at most three bytes.
// Backspace is left alone so the colon can be deleted. Pasting a full MAC keeps just its last three bytes.
function formatMacSuffix(text, deleting) {
    let digits = String(text).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (digits.length === 12 && digits.startsWith(MAC_OUI.replace(/:/g, ''))) digits = digits.slice(6);
    digits = digits.slice(0, 6);
    const pairs = digits.match(/.{1,2}/g) || [];
    let formatted = pairs.join(':');
    if (!deleting && digits.length > 0 && digits.length < 6 && digits.length % 2 === 0) formatted += ':';
    return formatted;
}
$('networkMac').addEventListener('input', (event) => {
    const field = event.target;
    const deleting = Boolean(event.inputType && event.inputType.startsWith('delete'));
    const formatted = formatMacSuffix(field.value, deleting);
    if (formatted !== field.value) field.value = formatted;
});

function syncDhcpFields() {
    $('networkIp').disabled = $('networkDhcp').checked;
}
$('networkDhcp').addEventListener('change', syncDhcpFields);
['networkDhcp', 'networkIp', 'networkPort', 'networkMac'].forEach((id) => $(id).addEventListener('input', () => { networkFieldsDirty = true; }));
$('networkDhcp').addEventListener('change', () => { networkFieldsDirty = true; });
syncDhcpFields();

// Everything shown comes from the controller's own netinfo/macinfo reply, never from what was last typed.
function renderControllerNetwork(value) {
    const info = (value.network || {}).controller;
    let note = '';
    if (value.transport === 'remote') note = "This PC follows a master PC; read the controller's network settings on that PC.";
    else if (!value.connected) note = 'Connect to the controller to read its network settings.';
    else if (!info) note = "Reading the controller's network settings...";
    else if (!info.supported) note = "Not reported by this firmware. The address is on the controller's touchscreen Settings page.";
    const usable = Boolean(value.connected && value.transport !== 'remote' && info && info.supported);
    if (!usable) {
        ['ctlIp', 'ctlPort', 'ctlDhcp', 'ctlStaticIp', 'ctlMac', 'adminControllerNet'].forEach((id) => { $(id).textContent = '-'; });
        $('ctlNote').textContent = note;
    } else {
        $('ctlIp').textContent = info.ip;
        $('ctlPort').textContent = info.port;
        $('ctlDhcp').textContent = info.dhcp ? 'Automatic (DHCP)' : 'Static';
        $('ctlStaticIp').textContent = info.staticIp;
        $('ctlMac').textContent = info.mac;
        $('ctlNote').textContent = `Read from the controller at ${new Date(info.readAt).toLocaleTimeString()}${info.simulated ? ' (simulated values)' : ''}.`;
        $('adminControllerNet').textContent = `${info.ip} · port ${info.port} · ${info.mac}`;
        // Fill the edit fields from the controller once per reading, never over something the operator is typing.
        const editing = ['networkIp', 'networkPort', 'networkMac'].includes(document.activeElement && document.activeElement.id);
        if (info.readAt !== shownControllerReadAt && !networkFieldsDirty && !editing) {
            $('networkDhcp').checked = info.dhcp;
            $('networkIp').value = info.staticIp;
            $('networkPort').value = info.port;
            $('networkMac').value = macSuffixOf(info.mac);
            syncDhcpFields();
        }
        shownControllerReadAt = info.readAt;
    }
}

async function refreshControllerInfo() {
    $('refreshControllerInfo').disabled = true;
    const result = await window.windTunnel.readControllerInfo();
    $('refreshControllerInfo').disabled = false;
    if (result && result.ok === false && result.message) $('ctlNote').textContent = result.message;
}
$('refreshControllerInfo').addEventListener('click', refreshControllerInfo);

$('saveNetwork').addEventListener('click', async () => {
    const parts = $('networkIp').value.trim().split('.');
    const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
    const dhcp = $('networkDhcp').checked;
    const port = Number($('networkPort').value);
    if (!dhcp && (octets.length !== 4 || octets.some((octet) => !(octet >= 0 && octet <= 255)))) {
        $('networkAck').textContent = 'Enter the static IP as four numbers from 0 to 255, for example 192.168.1.150.';
        return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        $('networkAck').textContent = 'Port must be a whole number from 1 to 65535.';
        return;
    }
    const info = ((lastNetworkValue || {}).network || {}).controller;
    const macSuffix = $('networkMac').value.trim();
    let mac;
    if (macSuffix) {
        const problem = macSuffixProblem(macSuffix);
        if (problem) { $('networkAck').textContent = problem; return; }
        // Only a MAC that differs from the reported one is sent, so an unchanged field never rewrites it.
        const wanted = `${MAC_OUI}:${macSuffix.replace(/-/g, ':').toUpperCase()}`;
        const reported = info && info.supported && info.mac ? info.mac.toUpperCase() : '';
        if (reported !== wanted) mac = wanted;
    }
    // The MAC is a device identity: re-ask for the Admin password if the session lapsed while this tab sat open.
    if (!(await ensureAdminUnlocked())) { $('networkAck').textContent = 'Admin session is locked - nothing was sent.'; return; }
    const [ip0, ip1, ip2, ip3] = octets.length === 4 ? octets : [192, 168, 1, 150];
    const lines = [dhcp ? `Obtain the address by DHCP, port ${port}.` : `Static address ${ip0}.${ip1}.${ip2}.${ip3}, port ${port}.`];
    if (mac) lines.push(`MAC address ${mac.replace(/-/g, ':').toUpperCase()}. A new MAC is a new identity for the router's DHCP, so the controller may get a different address.`);
    if (lastNetworkValue && lastNetworkValue.transport === 'ethernet') lines.push('You are connected over Ethernet: this link will drop while the controller restarts its network, then the app reconnects.');
    lines.push('The controller applies this immediately and may be unresponsive for several seconds. Continue?');
    if (!window.confirm(lines.join('\n\n'))) return;
    $('saveNetwork').disabled = true;
    $('networkAck').textContent = 'Sending to the controller and reading it back...';
    const result = await window.windTunnel.setNetwork(ip0, ip1, ip2, ip3, port, dhcp, mac);
    $('saveNetwork').disabled = false;
    $('networkAck').textContent = result.message;
    if (result.acknowledged) networkFieldsDirty = false;
    if (result.ok && !dhcp) { $('ethHost').value = `${ip0}.${ip1}.${ip2}.${ip3}`; $('ethPort').value = port; }
    log(result.message, result.ok ? 'info' : 'error');
});

// "Connect": saves the IP typed from the controller's touchscreen and switches network use on.
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

async function saveEthernetFromForm(enabled) {
    const host = $('ethHost').value.trim();
    const result = await window.windTunnel.saveEthernetSettings({ enabled, host, port: Number($('ethPort').value) });
    log(result.message, result.ok ? 'info' : 'error');
    return result;
}

$('saveEthernet').addEventListener('click', async () => {
    const host = $('ethHost').value.trim();
    const octets = host.match(IPV4_PATTERN);
    if (!host) { $('ethAck').textContent = "Type the IP address shown on the controller's touchscreen first."; $('ethHost').focus(); return; }
    if (octets && octets.slice(1).some((octet) => Number(octet) > 255)) { $('ethAck').textContent = 'An IP address is four numbers from 0 to 255, for example 192.168.1.150.'; $('ethHost').focus(); return; }
    $('ethEnabled').checked = true;
    $('saveEthernet').disabled = true;
    const result = await saveEthernetFromForm(true);
    $('saveEthernet').disabled = false;
    $('ethAck').textContent = result.ok ? `Connecting to ${host}... If nothing happens, check that address on the controller's touchscreen: it can change after the controller drops an unknown device.` : result.message;
    if (lastNetworkValue) renderNetHero(lastNetworkValue);
});

$('ethEnabled').addEventListener('change', async () => {
    const enabled = $('ethEnabled').checked;
    if (lastNetworkValue) renderNetHero(lastNetworkValue);
    const result = await saveEthernetFromForm(enabled);
    if (!result.ok) { $('ethEnabled').checked = !enabled; $('ethAck').textContent = result.message; }
    if (lastNetworkValue) renderNetHero(lastNetworkValue);
});

// One click from "found" to "saved and connecting": fill in the address, switch network use on and save.
async function useFoundController(device) {
    $('ethHost').value = device.host;
    $('ethPort').value = device.port;
    $('ethEnabled').checked = true;
    const result = await window.windTunnel.saveEthernetSettings({ enabled: true, host: device.host, port: Number(device.port) });
    $('ethAck').textContent = result.ok ? `Found the controller at ${device.host} and saved it. This PC will use the network whenever the USB cable is not plugged in.` : result.message;
    log(result.message, result.ok ? 'info' : 'error');
    if (lastNetworkValue) renderNetHero(lastNetworkValue);
}

$('scanNetwork').addEventListener('click', async () => {
    const button = $('scanNetwork');
    button.disabled = true;
    $('scanResults').textContent = 'Scanning this PC\'s network for controllers...';
    const result = await window.windTunnel.scanNetwork(Number($('ethPort').value));
    button.disabled = false;
    if (!result.ok) { $('scanResults').textContent = result.message; return; }
    if (!result.devices.length) {
        $('scanResults').textContent = `No controller answered on port ${$('ethPort').value} (${result.subnets.join(', ')}). The controller serves one client at a time, so one already connected will not answer.`;
        return;
    }
    const usable = result.devices.filter((device) => !device.locked);
    if (usable.length === 1 && result.devices.length === 1) await useFoundController(usable[0]);
    $('scanResults').replaceChildren(...result.devices.map((device) => {
        const row = document.createElement('div');
        const use = document.createElement('button');
        use.className = 'btn btn-xs btn-outline mr-2';
        use.textContent = 'Use';
        use.addEventListener('click', () => useFoundController(device));
        const lockedText = {
            'usb-in-control': 'a controller under USB control',
            refused: 'something on this port that did not accept this PC',
            timeout: 'a controller that did not finish the handshake'
        }[device.locked];
        row.append(use, document.createTextNode(device.locked ? `${device.host}:${device.port} · ${lockedText || 'a controller that refused this PC'}` : `${device.host}:${device.port} · API v${device.apiVersion}`));
        return row;
    }));
});

$('saveRelay').addEventListener('click', async () => {
    const result = await window.windTunnel.saveRelaySettings({ mode: $('relayMode').value, port: Number($('relayPort').value) });
    $('relayAck').textContent = result.message;
    log(result.message, result.ok ? 'info' : 'error');
    refreshNetworkSettings();
});

$('regenCode').addEventListener('click', async () => {
    if (!window.confirm('Generate a new access code? Every connected remote device will be disconnected.')) return;
    const result = await window.windTunnel.regenerateAccessCode();
    if (result.ok) $('relayCode').textContent = result.accessCode;
    log('Remote access code regenerated; connected devices were disconnected');
});

$('remoteConnect').addEventListener('click', async () => {
    $('remoteAck').textContent = 'Connecting...';
    $('remoteConnect').disabled = true;
    const result = await window.windTunnel.connectRemote($('remoteHost').value, Number($('remotePort').value), $('remoteCode').value);
    $('remoteConnect').disabled = false;
    $('remoteAck').textContent = result.message;
    if (result.ok) $('remoteCode').value = '';
    log(result.message, result.ok ? 'info' : 'error');
});

$('remoteDisconnect').addEventListener('click', async () => {
    await window.windTunnel.disconnectRemote();
    $('remoteAck').textContent = 'Disconnected. This app is searching for a local controller again.';
    log('Disconnected from the master PC');
});

// Bootloader connect/hex-load/erase-program-verify flow, ported from Process Control V2's
// index.html (connectBootloader(), loadHexFile(), eraseProgramVerify(), runApplication()). The
// client drives the Erase -> Program -> Verify sequence itself by calling the three dedicated
// bridge methods in order -- the main process does not auto-chain them.
let bootloaderConnected = false;
let hexFileLoaded = false;

// The label shows only the file name, and only while a hex file is actually loaded in the current
// bootloader session; the full path is never displayed.
function clearHexFile() {
    hexFileLoaded = false;
    state.hexPath = null;
    $('hexFilePathLabel').textContent = 'No hex file loaded';
}

function firmwareUsbIds() {
    return { vid: $('bootloaderVid').value.trim(), pid: $('bootloaderPid').value.trim() };
}

function showFirmwareProgress(label) {
    $('firmwareProgressSection').classList.remove('hidden');
    $('firmwareProgressLabel').textContent = label;
    $('firmwareProgressFill').removeAttribute('value');
}

function hideFirmwareProgress() {
    $('firmwareProgressSection').classList.add('hidden');
}

// Mirrors Process Control V2's setBootloaderButtonState()/enableBootloaderButtons(): only the
// buttons valid for the current connection/hex-load stage are enabled. 'busy' disables everything
// while an Erase-Program-Verify or Run sequence is in flight.
function setBootloaderButtonState(bootState) {
    const ids = ['connectBtn', 'triggerBootloaderBtn', 'loadHexBtn', 'eraseProgramVerify', 'runAppBtn'];
    const enable = (id, value) => { const el = $(id); if (el) el.disabled = !value; };
    bootloaderButtonState = bootState;
    switch (bootState) {
        case 'disconnected':
            enable('connectBtn', true); enable('triggerBootloaderBtn', hardwareOnline && !triggerPending); enable('loadHexBtn', false); enable('eraseProgramVerify', false); enable('runAppBtn', false);
            break;
        case 'connected':
            enable('connectBtn', true); enable('triggerBootloaderBtn', false); enable('loadHexBtn', true); enable('eraseProgramVerify', false); enable('runAppBtn', false);
            break;
        case 'hex_loaded':
            enable('connectBtn', true); enable('triggerBootloaderBtn', false); enable('loadHexBtn', true); enable('eraseProgramVerify', true); enable('runAppBtn', false);
            break;
        case 'busy':
            ids.forEach((id) => enable(id, false));
            break;
        case 'ready_to_run':
            ids.forEach((id) => enable(id, false));
            enable('runAppBtn', true);
            break;
        default:
            break;
    }
}

function enableBootloaderButtons(enabled) {
    setBootloaderButtonState(enabled ? (hexFileLoaded ? 'hex_loaded' : 'connected') : 'disconnected');
}

function refreshTriggerButton() {
    if (bootloaderButtonState !== 'disconnected') return;
    const btn = $('triggerBootloaderBtn');
    if (btn) btn.disabled = !(hardwareOnline && !triggerPending);
}

function clearTriggerPending() {
    triggerPending = false;
    triggerSawOffline = false;
    clearTimeout(triggerPendingTimer);
    triggerPendingTimer = null;
}

// Called from render() on every pushed state. A sent trigger keeps the button grey until the link has
// gone offline and come back online, which is the controller returning from bootloader mode.
function noteHardwareState(online) {
    hardwareOnline = online;
    if (triggerPending) {
        if (!online) triggerSawOffline = true;
        else if (triggerSawOffline) clearTriggerPending();
    }
    refreshTriggerButton();
}

// Mirrors Process Control V2's triggerBootloader(): send the JSON trigger, then leave Connect enabled
// (Connect itself polls for the HID device while it re-enumerates).
$('triggerBootloaderBtn').addEventListener('click', async () => {
    triggerPending = true;
    triggerSawOffline = false;
    refreshTriggerButton();
    log('Sending bootloader trigger...', 'info');
    try {
        const result = await window.windTunnel.bootloaderTrigger();
        if (result && result.ok) {
            log(result.message, 'info');
            $('connectBtn').disabled = false;
            // If the controller ignores the command (older firmware) the link never drops, so give the
            // button back after a while instead of leaving it grey for good.
            triggerPendingTimer = setTimeout(() => { clearTriggerPending(); refreshTriggerButton(); }, 20000);
        } else {
            log(`Failed: ${result ? result.message : 'Unknown'}`, 'error');
            clearTriggerPending();
            refreshTriggerButton();
        }
    } catch (error) {
        log(`Error: ${error.message}`, 'error');
        clearTriggerPending();
        refreshTriggerButton();
    }
});

$('connectBtn').addEventListener('click', async () => {
    const connectBtn = $('connectBtn');
    if (bootloaderConnected) {
        log('Disconnecting from bootloader...', 'info');
        await window.windTunnel.bootloaderDisconnect();
        bootloaderConnected = false;
        clearHexFile();
        connectBtn.textContent = 'Connect';
        setBootloaderButtonState('disconnected');
        log('Disconnected', 'info');
        return;
    }

    const { vid, pid } = firmwareUsbIds();
    connectBtn.disabled = true;
    log('Connecting to bootloader...', 'info');
    try {
        const result = await window.windTunnel.bootloaderConnect(vid, pid);
        if (result && result.ok) {
            bootloaderConnected = true;
            clearHexFile();
            if (result.productId) $('bootloaderPid').value = result.productId;
            connectBtn.textContent = 'Disconnect';
            setBootloaderButtonState('connected');
            log('Connected -- load a hex file to continue', 'info');
        } else {
            log(result ? result.message : 'Connection failed', 'error');
            connectBtn.disabled = false;
            refreshTriggerButton();
        }
    } catch (error) {
        log(`Connection error: ${error.message}`, 'error');
        connectBtn.disabled = false;
        refreshTriggerButton();
    }
});

$('loadHexBtn').addEventListener('click', async () => {
    // Electron 32+ removed File.path, so the picker lives in the main process.
    const picked = await window.windTunnel.bootloaderPickHex();
    if (!picked) return;
    try {
        const result = await window.windTunnel.bootloaderLoadHex(picked);
        if (result && result.ok) {
            // Only an accepted file becomes the displayed/current one, so a rejected pick can never
            // leave the label naming a file different from the one actually loaded.
            state.hexPath = picked;
            $('hexFilePathLabel').textContent = picked.split(/[\\/]/).pop();
            hexFileLoaded = true;
            log('Hex loaded -- click Erase-Program-Verify', 'info');
            setBootloaderButtonState('hex_loaded');
        } else {
            log(result ? result.message : 'Hex load failed', 'error');
        }
    } catch (error) {
        log(`Hex load error: ${error.message}`, 'error');
    }
});

$('eraseProgramVerify').addEventListener('click', async () => {
    if (!hexFileLoaded) { log('Load a hex file first', 'error'); return; }
    log('Starting Erase-Program-Verify sequence...', 'info');
    setBootloaderButtonState('busy');
    try {
        log('Step 1/3: Erasing...', 'info');
        showFirmwareProgress('Erasing flash...');
        const erased = await window.windTunnel.bootloaderErase();
        if (!erased || !erased.ok) { hideFirmwareProgress(); log(erased ? erased.message : 'Erase failed', 'error'); setBootloaderButtonState('hex_loaded'); return; }
        log('Erase complete', 'info');

        log('Step 2/3: Programming...', 'info');
        showFirmwareProgress('Programming flash...');
        const programmed = await window.windTunnel.bootloaderProgram();
        if (!programmed || !programmed.ok) { hideFirmwareProgress(); log(programmed ? programmed.message : 'Program failed', 'error'); setBootloaderButtonState('hex_loaded'); return; }
        log('Program complete', 'info');

        log('Step 3/3: Verifying...', 'info');
        showFirmwareProgress('Verifying flash...');
        const verified = await window.windTunnel.bootloaderReadCrc();
        hideFirmwareProgress();
        if (verified && verified.ok) {
            log('All done -- click Run application', 'info');
            setBootloaderButtonState('ready_to_run');
        } else {
            log(verified ? verified.message : 'Verify failed', 'error');
            setBootloaderButtonState('hex_loaded');
        }
    } catch (error) {
        hideFirmwareProgress();
        log(`Error: ${error.message}`, 'error');
        setBootloaderButtonState('hex_loaded');
    }
});

$('runAppBtn').addEventListener('click', async () => {
    log('Jumping to application...', 'info');
    setBootloaderButtonState('busy');
    try {
        const result = await window.windTunnel.bootloaderJumpToApp();
        log(result && result.ok ? 'Application running' : (result ? result.message : 'Run failed'), result && result.ok ? 'info' : 'error');
    } catch (error) {
        log(`Error: ${error.message}`, 'error');
    }
    bootloaderConnected = false;
    clearHexFile();
    $('connectBtn').textContent = 'Connect';
    setBootloaderButtonState('disconnected');
});

setBootloaderButtonState('disconnected');

function updateFirmwareBanner() {
    $('firmwareBanner').hidden = $('bootloaderPid').value.trim() !== '';
}
$('bootloaderPid').addEventListener('input', updateFirmwareBanner);
updateFirmwareBanner();

window.windTunnel.onFirmwareProgress((entry) => {
    const row = document.createElement('div');
    row.textContent = `[${entry.stage}] ${entry.message}`;
    row.className = entry.level === 'error' ? 'log-error' : entry.level === 'warn' ? 'log-warning' : 'log-info';
    $('firmwareLog').prepend(row);
    if (!$('firmwareProgressSection').classList.contains('hidden')) {
        $('firmwareProgressLabel').textContent = entry.message;
    }
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
window.windTunnel.onLogEvent((event) => {
    $('logStatus').textContent = `Logging to ${event.path} (${event.rowCount} rows)`;
    if (!state.sweepRunning && !(state.currentExperiment && state.currentExperiment.sweepType)) $('logStatePill').classList.add('pill-active', 'badge-pulse');
});

// Download / restart prompts are native dialogs from the main process; this just shows status.
function showUpdateStatus(status) {
    const el = $('updateStatus');
    el.hidden = false;
    el.className = `update-status-message ${status.state === 'error' ? 'error' : status.state === 'current' || status.state === 'downloaded' ? 'success' : 'info'}`;
    el.textContent = status.message;
    $('updateButton').disabled = status.state === 'checking' || status.state === 'downloading';
    if (status.state !== 'downloading') log(status.message, status.state === 'error' ? 'error' : 'info');
}
window.windTunnel.onUpdateStatus(showUpdateStatus);
$('updateButton').addEventListener('click', () => window.windTunnel.checkForUpdates());

setView_bindNav();
window.windTunnel.onState(render);
window.windTunnel.getState().then(async (value) => {
    WindTunnelCharts.createCharts();
    WindTunnelCharts.createLutChart();
    updateLutChart();
    await loadExperiments(value.experimentId);
    render(value);
    log(value.simulation ? 'Wind Tunnel UI ready; explicit simulation mode active' : 'Wind Tunnel UI ready; searching for USB controller');
});
setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }, 1000);
