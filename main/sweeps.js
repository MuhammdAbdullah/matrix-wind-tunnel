const { state, publish, clamp } = require('./state');
const serial = require('./serial');
const logging = require('./logging');
const experiments = require('./experiments');

const DEFAULT_SAMPLE_TIME_MS = 1000;

let sensorTimer = null;
let sweepTimer = null;

serial.onUnexpectedDisconnect(() => stopSweep());

function startSensorSampleTimer(sampleTimeMs = DEFAULT_SAMPLE_TIME_MS) {
    if (sensorTimer) clearInterval(sensorTimer);
    sensorTimer = setInterval(async () => {
        if (state.simulation) return; // renderer-visible simulated sensors are driven elsewhere
        if (sweepTimer) return; // the active sweep's own tick already reads+logs each cycle
        try {
            await serial.readSensorsOnce({ source: 'system' });
            serial.reportReadOutcome(true);
            publish();
        } catch (_error) {
            serial.reportReadOutcome(false);
            state.diagnostics.errors += 1;
            publish();
        }
        if (state.logging.active && !experiments.getById(state.experimentId).sweepType) {
            logging.appendRow(buildRow(experiments.getById(state.experimentId)));
        }
    }, sampleTimeMs);
}

function buildRow(experiment) {
    const row = {
        time: new Date().toISOString(),
        fanSpeed: state.fanSpeed,
        angle: state.angle,
        lift: state.sensors.lift,
        drag: state.sensors.drag,
        pressure: state.sensors.pressure,
        velocity: state.sensors.velocity,
        tappingChannel: state.tapping.channel,
        dragShape: state.dragShape
    };
    if (experiment.id === 'custom') {
        row.customX = row[state.customAxes.x];
        row.customY = row[state.customAxes.y];
    }
    return row;
}

function advanceTapping() {
    const experiment = experiments.getById(state.experimentId);
    if (!experiment.fields.includes('tapping') || !state.tapping.increment) return;
    const next = state.tapping.channel + state.tapping.increment;
    state.tapping.channel = next > 23 ? 1 : next;
}

async function tick(moveActuator) {
    await moveActuator(state.sweep.current, { source: 'control' });
    try {
        await serial.readSensorsOnce({ source: 'control' });
        serial.reportReadOutcome(true);
    } catch (_error) {
        serial.reportReadOutcome(false);
        state.diagnostics.errors += 1;
    }
    const experiment = experiments.getById(state.experimentId);
    if (state.logging.active) logging.appendRow(buildRow(experiment));
    advanceTapping();
    publish();

    const reachedEnd = state.sweep.step > 0 ? state.sweep.current >= state.sweep.end : state.sweep.current <= state.sweep.end;
    if (reachedEnd) {
        stopSweep();
        return;
    }
    state.sweep.current += state.sweep.step;
}

function startSweep(type, options, moveActuator) {
    stopSweep();
    const defaults = experiments.SWEEP_DEFAULTS[type];
    const start = Number(options.start ?? defaults.start);
    const end = Number(options.end ?? defaults.end);
    const rawStep = Math.abs(Number(options.step ?? defaults.step)) || defaults.step;
    const step = end >= start ? Math.abs(rawStep) : -Math.abs(rawStep);
    const delay = Math.max(100, Number(options.delay ?? defaults.delay));

    state.sweep = { type, running: true, start, end, step, delay, current: start };
    publish();

    sweepTimer = setInterval(() => tick(moveActuator), delay);
    tick(moveActuator);
    return { ok: true, sweep: state.sweep };
}

function startAngleSweep(options = {}) {
    return startSweep('angle', options, serial.setAngle);
}

function startFanSweep(options = {}) {
    return startSweep('fan', options, serial.setFanSpeed);
}

function stopSweep() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    if (state.sweep.running) {
        state.sweep = { ...state.sweep, running: false, current: state.sweep.start };
        publish();
    }
    return { ok: true, sweep: state.sweep };
}

function status() {
    return state.sweep;
}

module.exports = { startSensorSampleTimer, startAngleSweep, startFanSweep, stopSweep, status };
