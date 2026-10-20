const $ = (id) => document.getElementById(id);
const format = (value, digits = 2) => Number(value || 0).toFixed(digits);

// Mirrors main/experiments.js's CHORD_FRACTIONS/chordPositionFor (Worksheet 3's fixed
// tapping-to-chord-position table) for the renderer-only "x = ..." readout next to the
// Tapping Channel input -- kept in sync with the main-process copy used for the logged row.
const CHORD_FRACTIONS = [0, 0.01, 0.03, 0.06, 0.12, 0.18, 0.30, 0.40, 0.51, 0.60, 0.70, 0.80];
function chordPositionFor(channel) {
    const ch = Math.min(23, Math.max(1, Number(channel) || 1));
    if (ch === 1) return { x: 0, surface: 'both' };
    if (ch <= 12) return { x: CHORD_FRACTIONS[ch - 1], surface: 'upper' };
    return { x: CHORD_FRACTIONS[ch - 12], surface: 'lower' };
}

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

// Groups manualLog history points into separate chart "runs" the same way sweeps already do
// (see MAX_SWEEP_TRACES/buildSweepRunLabel above), so repeating a Cylinder angle sweep at a
// different fan speed, or an Aerofoil chord sweep at a different angle of attack (Worksheets
// 2 and 3's "Challenge" exercises), overlays as distinct comparable traces instead of one
// run's points silently mixing into the next.
function manualLogRunKey(experiment, point) {
    if (experiment.id === 'pressureTappedCylinder') return `${point.fanSpeed}% Fan`;
    if (experiment.id === 'pressureTappedAerofoil') return `${point.aerofoilAoA}° AoA @ ${point.fanSpeed}% Fan`;
    return null;
}

function groupManualLogHistory(experiment, points) {
    const runs = [];
    const byLabel = new Map();
    points.forEach((point) => {
        const label = manualLogRunKey(experiment, point);
        let run = byLabel.get(label);
        if (!run) { run = { label, points: [] }; byLabel.set(label, run); runs.push(run); }
        run.points.push({ x: point[experiment.xField], sensors: point });
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

const PRESSURE_DIST_EXPERIMENTS = ['pressureTappedCylinder', 'pressureTappedAerofoil'];

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
    if (PRESSURE_DIST_EXPERIMENTS.includes(state.currentExperiment.id)) {
        const historySeries = state.experimentHistory.slice(-2000);
        const runs = groupManualLogHistory(state.currentExperiment, historySeries);
        WindTunnelCharts.updateHistoryRuns(runs, experiment);
        const pointCount = runs.reduce((sum, run) => sum + run.points.length, 0);
        $('historyCount').textContent = pointCount > 0 ? `${pointCount} pts across ${runs.length} run(s)` : 'No logged points yet';
        renderPressureDistribution(state.currentExperiment, runs);
        return;
    }
    const historySeries = state.experimentHistory.slice(-300);
    WindTunnelCharts.updateHistory(historySeries, experiment, state.customAxes);
    $('historyCount').textContent = historySeries.length > 0 ? `${historySeries.length} pts` : 'No logged points yet';
}

// Keeps the "which run am I looking at" dropdown in sync with the runs currently grouped
// out of experimentHistory, defaulting to the most recently started run.
let selectedPressureDistRun = null;
function renderPressureDistribution(experiment, runs) {
    const select = $('pressureDistRunSelect');
    const labels = runs.map((run) => run.label);
    if (select.dataset.labels !== labels.join('|')) {
        select.dataset.labels = labels.join('|');
        select.innerHTML = labels.map((label) => `<option value="${label}">${label}</option>`).join('');
        if (!labels.includes(selectedPressureDistRun)) selectedPressureDistRun = labels[labels.length - 1] || null;
    }
    select.value = selectedPressureDistRun || '';
    const run = runs.find((candidate) => candidate.label === selectedPressureDistRun) || runs[runs.length - 1];
    WindTunnelCharts.drawPressureDistribution($('pressureDistChart'), experiment, run ? run.points : []);
}
$('pressureDistRunSelect').addEventListener('change', (event) => {
    selectedPressureDistRun = event.target.value;
    renderCharts();
});

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
    if (tabName === 'calibrator') { refreshScalers(); refreshLut(); }
}

function applyExperiment(experiment) {
    state.currentExperiment = experiment;
    $('liveChartTitle').textContent = experiment.id === 'custom' ? WindTunnelCharts.customTitle(state.customAxes) : experiment.title;
    $('historyChartTitle').textContent = experiment.id === 'custom' ? WindTunnelCharts.customTitle(state.customAxes) : experiment.title;
    updateChartVisibility(experiment);
    const fields = experiment.fields || [];
    $('tappingFields').classList.toggle('hidden', !fields.includes('tapping'));
    $('manualAngleField').classList.toggle('hidden', !fields.includes('manualAngle'));
    $('manualAngleCurrentFieldWrap').classList.toggle('hidden', !fields.includes('manualAngle'));
    $('aerofoilAoAField').classList.toggle('hidden', !fields.includes('aerofoilAoA'));
    $('cpReadout').classList.toggle('hidden', !PRESSURE_DIST_EXPERIMENTS.includes(experiment.id));
    $('pressureDistPanel').classList.toggle('hidden', !PRESSURE_DIST_EXPERIMENTS.includes(experiment.id));
    selectedPressureDistRun = null;
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

function render(value) {
    const stemRacingChartTypeChanged = state.lastDeviceState && state.lastDeviceState.stemRacingChartType !== value.stemRacingChartType;
    state.lastDeviceState = value;
    state.connected = value.connected;
    state.simulation = value.simulation;
    state.sweepRunning = value.sweep.running;

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

    $('connectionBadge').textContent = value.connected ? (value.simulation ? 'SIMULATION MODE' : 'SYSTEM ONLINE') : 'SYSTEM OFFLINE';
    $('connectionBadge').className = `badge badge-sm gap-1 font-bold tracking-wider uppercase ${value.connected ? 'badge-success' : 'badge-error'}`;

    $('adminConnectionPill').textContent = value.connected ? 'Connected' : 'Searching';
    $('adminConnectionPill').className = `badge ${value.connected ? 'badge-success' : 'badge-error'}`;
    $('adminTransport').textContent = value.connected ? `${value.simulation ? 'Simulation' : 'USB serial'} · ${value.port}` : 'USB serial · waiting';
    $('adminRetries').textContent = value.diagnostics.retries;
    $('adminErrors').textContent = value.diagnostics.errors;

    $('fanSlider').value = value.fanSpeed;
    $('angleSlider').value = value.angle;
    if (document.activeElement !== $('fanValue')) $('fanValue').value = value.fanSpeed;
    if (document.activeElement !== $('angleValue')) $('angleValue').value = value.angle;
    renderMetrics(value.sensors, value.connected);

    // Pressure Tapped Cylinder's hand-rotated dial: no motor moves it, so this readout is the
    // only visible feedback that the counter actually advanced after each Log Point click.
    $('manualAngleCurrentSlider').value = value.manualAngle.current;
    if (document.activeElement !== $('manualAngleCurrentValue')) $('manualAngleCurrentValue').value = value.manualAngle.current;
    if (document.activeElement !== $('aerofoilAoAInput')) $('aerofoilAoAInput').value = value.aerofoilAoA;

    if (value.experimentId === 'pressureTappedAerofoil' && document.activeElement !== $('tappingChannel')) {
        const { x, surface } = chordPositionFor(value.tapping.channel);
        const surfaceLabel = surface === 'both' ? 'leading edge, both surfaces' : `${surface} surface`;
        $('tappingChordReadout').textContent = `x = ${x.toFixed(2)} (${surfaceLabel})`;
    }

    if (PRESSURE_DIST_EXPERIMENTS.includes(value.experimentId)) {
        const point = value.lastLoggedPoint;
        if (point && point.cp !== null && point.cp !== undefined) {
            $('cpReadout').innerHTML = `Last point: Cp = <strong>${point.cp.toFixed(3)}</strong> (P&infin; = ${format(point.freeStreamPressure, 1)} Pa, from pitot-static calibration)`;
        } else if (point) {
            $('cpReadout').innerHTML = `<span class="log-warning">No Cp — no pitot-static (Convert Pressure to Velocity) calibration logged near ${value.fanSpeed}% fan speed yet.</span>`;
        } else {
            $('cpReadout').textContent = 'Log a point to compute Cp.';
        }
    }

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

    const showLogPill = value.logging.active && !value.sweep.running;
    $('logStatePill').classList.toggle('pill-active', showLogPill);
    $('logStatePill').classList.toggle('badge-pulse', showLogPill);

    // A publish only carries a genuinely new sensor reading when value.sensorSampleSeq
    // has moved on from the last one we recorded -- any other publish (fan/angle slider
    // commit, LED write, experiment/tapping/drag-shape change, a retry-exhausted
    // setAngle/setFanSpeed error, etc.) still reaches render() but must not log another
    // chart point off the same still-stale sensor values. See state.js's sensorSampleSeq
    // comment. Compared once per render() call, not per branch below.
    const freshSample = value.sensorSampleSeq !== state.lastSensorSampleSeq;
    if (value.connected && state.currentExperiment) {
        if (freshSample) state.liveSamples.push({ ...value.sensors, fanSpeed: value.fanSpeed, angle: value.angle, time: Date.now() });
        if (state.currentExperiment.sweepType) {
            if (value.sweep.running && !state.sweepWasRunning) {
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
            if (freshLoggedPoint && value.lastLoggedPoint) state.experimentHistory.push({ ...value.lastLoggedPoint });
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
$('tappingChannel').addEventListener('change', (event) => window.windTunnel.setTapping(Number(event.target.value), Number($('tappingIncrement').value)));
$('tappingIncrement').addEventListener('change', (event) => window.windTunnel.setTapping(Number($('tappingChannel').value), Number(event.target.value)));
$('manualAngleIncrementSelect').addEventListener('change', (event) => window.windTunnel.setManualAngleIncrement(Number(event.target.value)));
$('manualAngleCurrentSlider').addEventListener('change', async (event) => { await window.windTunnel.setManualAngleCurrent(event.target.value); log(`Cylinder angle set to ${event.target.value}°`); });
$('manualAngleCurrentValue').addEventListener('change', async (event) => {
    const clamped = Math.min(180, Math.max(-180, Math.round(Number(event.target.value) || 0)));
    event.target.value = clamped;
    $('manualAngleCurrentSlider').value = clamped;
    await window.windTunnel.setManualAngleCurrent(clamped);
    log(`Cylinder angle set to ${clamped}°`);
});
$('manualAngleCurrentValue').addEventListener('keydown', (event) => { if (event.key === 'Enter') event.target.blur(); });
$('aerofoilAoAInput').addEventListener('change', async (event) => {
    const clamped = Math.min(45, Math.max(-45, Math.round(Number(event.target.value) || 0)));
    event.target.value = clamped;
    await window.windTunnel.setAerofoilAoA(clamped);
    log(`Aerofoil angle of attack set to ${clamped}° (reposition the aerofoil to match)`);
});
$('aerofoilAoAInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') event.target.blur(); });
$('tappingChannel').addEventListener('input', (event) => {
    const { x, surface } = chordPositionFor(event.target.value);
    const surfaceLabel = surface === 'both' ? 'leading edge, both surfaces' : `${surface} surface`;
    $('tappingChordReadout').textContent = `x = ${x.toFixed(2)} (${surfaceLabel})`;
});
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

$('startSweep').addEventListener('click', async () => {
    const options = { start: Number($('sweepStart').value), end: Number($('sweepEnd').value), step: Number($('sweepStep').value), delay: Number($('sweepDelay').value) * 1000 };
    const result = state.currentExperiment.sweepType === 'angle' ? await window.windTunnel.startAngleSweep(options) : await window.windTunnel.startFanSweep(options);
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
$('logPointButton').addEventListener('click', async () => {
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

function openAdminPasswordModal() {
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
            $('adminPasswordError').textContent = result.needsSetup ? 'Admin setup required.' : 'Incorrect password.';
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
                <input type="number" step="0.01" class="input input-bordered input-sm w-20" id="lutInput${index}" value="${value}">
                <button class="btn btn-outline btn-xs lut-save" data-index="${index}">Save</button>
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

// Bootloader connect/hex-load/erase-program-verify flow, ported from Process Control V2's
// index.html (connectBootloader(), loadHexFile(), eraseProgramVerify(), runApplication()). The
// client drives the Erase -> Program -> Verify sequence itself by calling the three dedicated
// bridge methods in order -- the main process does not auto-chain them.
let bootloaderConnected = false;
let hexFileLoaded = false;

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
    const ids = ['connectBtn', 'loadHexLabel', 'eraseProgramVerify', 'runAppBtn'];
    const enable = (id, value) => { const el = $(id); if (el) el.disabled = !value; };
    $('hexFile').disabled = true;
    switch (bootState) {
        case 'disconnected':
            enable('connectBtn', true); enable('loadHexLabel', false); enable('eraseProgramVerify', false); enable('runAppBtn', false);
            break;
        case 'connected':
            enable('connectBtn', true); enable('loadHexLabel', true); enable('eraseProgramVerify', false); enable('runAppBtn', false);
            $('hexFile').disabled = false;
            break;
        case 'hex_loaded':
            enable('connectBtn', true); enable('loadHexLabel', true); enable('eraseProgramVerify', true); enable('runAppBtn', false);
            $('hexFile').disabled = false;
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

$('connectBtn').addEventListener('click', async () => {
    const connectBtn = $('connectBtn');
    if (bootloaderConnected) {
        log('Disconnecting from bootloader...', 'info');
        await window.windTunnel.bootloaderDisconnect();
        bootloaderConnected = false;
        hexFileLoaded = false;
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
            connectBtn.textContent = 'Disconnect';
            setBootloaderButtonState('connected');
            log('Connected -- load a hex file to continue', 'info');
        } else {
            log(result ? result.message : 'Connection failed', 'error');
            connectBtn.disabled = false;
        }
    } catch (error) {
        log(`Connection error: ${error.message}`, 'error');
        connectBtn.disabled = false;
    }
});

$('hexFile').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    state.hexPath = file?.path || null;
    $('hexFilePathLabel').textContent = state.hexPath || 'No hex file loaded';
    if (!state.hexPath) return;
    try {
        const result = await window.windTunnel.bootloaderLoadHex(state.hexPath);
        if (result && result.ok) {
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
    hexFileLoaded = false;
    $('connectBtn').textContent = 'Connect';
    setBootloaderButtonState('disconnected');
});

setBootloaderButtonState('disconnected');

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
    if (!state.sweepRunning) $('logStatePill').classList.add('pill-active', 'badge-pulse');
});

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
