const { state, publish, clamp } = require('./state');
const serial = require('./serial');
const logging = require('./logging');
const experiments = require('./experiments');

const DEFAULT_SAMPLE_TIME_MS = 1000;

let sensorTimer = null;
let sweepTimer = null;
let sensorReadInFlight = false;
// Bumped on every sweep start/stop so a tick that was mid-await when the sweep ended cannot act afterwards.
let sweepToken = 0;
let sweepReadFailures = 0;
const MAX_CONSECUTIVE_SWEEP_READ_FAILURES = 2;

serial.onUnexpectedDisconnect(() => stopSweep());

function startSensorSampleTimer(sampleTimeMs = DEFAULT_SAMPLE_TIME_MS) {
    if (sensorTimer) clearInterval(sensorTimer);
    sensorTimer = setInterval(async () => {
        if (state.simulation) return; // renderer-visible simulated sensors are driven elsewhere
        if (state.sweep.running) return; // the active sweep's own tick already reads+logs each cycle
        if (!state.connected) return; // nothing to read; the serial layer is already reconnecting
        if (sensorReadInFlight) return; // never stack reads behind a slow/unresponsive controller
        sensorReadInFlight = true;
        try {
            try {
                await serial.readSensorsOnce({ source: 'system' });
                publish();
            } catch (_error) {
                state.diagnostics.errors += 1;
                publish();
                return; // no fresh reading: never log a stale sensor row under a new timestamp
            }
            // Only sensorsVsTime logs continuously on this timer -- the legacy source's own timer
            // wiring only auto-triggers OnLogButtonClick on every sensor-sample tick when
            // Exercise = 6; every other no-sweep experiment (manualLog: true) is logged one point
            // at a time via logPoint(), fired by the renderer's "Log Point" button.
            const experiment = experiments.getById(state.experimentId);
            if (state.logging.active && !experiment.sweepType && !experiment.manualLog) {
                logging.appendRow(buildRow(experiment));
                advanceTapping(experiment);
                advanceManualAngle(experiment);
                await advanceFanSpeedOnLog(experiment);
            }
        } finally {
            sensorReadInFlight = false;
        }
    }, sampleTimeMs);
}

function buildRow(experiment) {
    // Pressure Tapped Aerofoil splits its single pressure reading across two chart/CSV
    // traces by tapping channel (top surface 1-12, bottom surface 13-23; channel 1 is the
    // shared reference point and belongs to both) -- mirrors the legacy source's two
    // Chart_XY.AddPoint() calls for that experiment.
    const channel = state.tapping.channel;
    const row = {
        time: new Date().toISOString(),
        fanSpeed: state.fanSpeed,
        angle: state.angle,
        lift: state.sensors.lift,
        drag: state.sensors.drag,
        pressure: state.sensors.pressure,
        pressureTop: channel <= 12 ? state.sensors.pressure : null,
        pressureBottom: channel === 1 || channel > 12 ? state.sensors.pressure : null,
        velocity: state.sensors.velocity,
        tappingChannel: channel,
        aerofoilAngle: state.aerofoilAngle,
        dragShape: state.dragShape
    };
    if (experiment.id === 'pressureTappedCylinder') {
        // The hardware gauge runs -180..180; the cylinder is plotted/logged as one continuous 0..360 sweep.
        row.angle = ((state.angle % 360) + 360) % 360;
    }
    if (experiment.id === 'pressureTappedAerofoil') {
        row.tappingX = experiments.tappingXFor(channel);
    }
    if (experiment.id === 'custom') {
        row.customX = row[state.customAxes.x];
        row.customY = row[state.customAxes.y];
    }
    return row;
}

// The discrete capture action for manualLog experiments (pressureToVelocity,
// pressureTappedCylinder, pressureTappedAerofoil, dragCoefficient, custom): mirrors the
// legacy source's single "Log" button click -- one chart point always, one CSV row only if
// a log file is open, then auto-advance the driven value ready for the next click.
async function logPoint() {
    const experiment = experiments.getById(state.experimentId);
    const row = buildRow(experiment);
    if (state.logging.active) logging.appendRow(row);
    state.lastLoggedPoint = row;
    state.loggedPointSeq += 1;
    advanceTapping(experiment);
    await advanceManualAngle(experiment);
    publish();
    await advanceFanSpeedOnLog(experiment);
    publish();
    return { ok: true, row };
}

function advanceTapping(experiment) {
    if (!experiment.fields.includes('tapping') || !state.tapping.increment) return;
    const next = state.tapping.channel + state.tapping.increment;
    state.tapping.channel = next > 23 ? 1 : next;
}

// Pressure Tapped Cylinder uses the same angle gauge as the motor: each logged point bumps it by
// "Increment Angle" (wrapping +180 -> -180), which in the legacy source's gauge-change handler
// sends SetMotorAngle -- so this drives the real hardware angle, like advanceFanSpeedOnLog.
async function advanceManualAngle(experiment) {
    if (!experiment.fields.includes('manualAngle') || !state.manualAngle.increment) return;
    const next = state.angle + state.manualAngle.increment;
    // Past +180 the gauge continues from -180 (same physical position), so the 0..360 plot stays continuous.
    await serial.setAngle(next > 180 ? next - 360 : next, { source: 'control' });
}

// Drag Coefficient has no sweep switch in the legacy source -- the operator sets fan speed,
// clicks Log, and the gauge itself auto-bumps by "Increment Speed" (wrapping 100 -> 0) as a
// convenience for the next click. Same hardware-driven behaviour as advanceManualAngle.
async function advanceFanSpeedOnLog(experiment) {
    if (!experiment.fields.includes('fanSpeedIncrement') || !state.fanSpeedIncrement) return;
    const next = state.fanSpeed + state.fanSpeedIncrement;
    await serial.setFanSpeed(next > 100 ? 0 : next, { source: 'control' });
}

// Moves to state.sweep.current, then WAITS there to let the motor/fan actually arrive and the
// firmware's sensor running-average filter settle before reading -- reading right after sending
// the move command (the old behavior) captured an in-transit or not-yet-settled value. The
// firmware acks a move command immediately but the stepper/PWM ramp then takes real time
// proportional to distance, with no "arrived" readback -- so a fixed per-step delay (tuned for a
// normal `step`-sized move) isn't enough for the sweep's *first* move, which jumps from wherever
// the motor/fan currently sits to `start` and can be a much larger distance than one step (most
// visible on the first logged point after a big jump to the sweep's start angle). Scale the wait
// by how far this particular move actually travelled relative to one normal step, instead of
// always using the configured per-step delay verbatim.
async function tick(moveActuator, fromValue, token) {
    if (token !== sweepToken || !state.sweep.running) return;
    if (!state.connected) { stopSweep(); return; }
    const target = state.sweep.current;
    await moveActuator(target, { source: 'control' });
    if (token !== sweepToken || !state.sweep.running) return; // stopped while the move was in flight

    const distance = Math.abs(target - fromValue);
    const normalStep = Math.abs(state.sweep.step) || 1;
    const settleDelay = Math.max(state.sweep.delay, Math.round(state.sweep.delay * (distance / normalStep)));

    sweepTimer = setTimeout(async () => {
        if (token !== sweepToken || !state.sweep.running) return; // stopped during the settle wait

        let readOk = true;
        try {
            await serial.readSensorsOnce({ source: 'control' });
        } catch (_error) {
            readOk = false;
            state.diagnostics.errors += 1;
        }
        if (token !== sweepToken || !state.sweep.running) return; // stopped (or link lost) during the read

        const experiment = experiments.getById(state.experimentId);
        if (readOk) {
            sweepReadFailures = 0;
            if (state.logging.active) {
                logging.appendRow(buildRow(experiment));
                advanceTapping(experiment);
                advanceManualAngle(experiment);
            }
        } else {
            // No fresh reading: skip the row rather than logging stale sensors under a new timestamp,
            // and give up if the controller keeps failing to answer.
            sweepReadFailures += 1;
            if (sweepReadFailures >= MAX_CONSECUTIVE_SWEEP_READ_FAILURES) {
                console.log('[sweeps] Controller stopped answering sensor reads; stopping sweep');
                stopSweep();
                return;
            }
        }
        publish();

        const reachedEnd = state.sweep.step > 0 ? state.sweep.current >= state.sweep.end : state.sweep.current <= state.sweep.end;
        if (reachedEnd) {
            stopSweep();
            return;
        }
        state.sweep.current += state.sweep.step;
        tick(moveActuator, target, token);
    }, settleDelay);
}

function startSweep(type, options, moveActuator) {
    if (!state.connected) return { ok: false, message: 'Controller not connected; sweep not started' };
    stopSweep(); // also advances sweepToken, invalidating any tick from the previous sweep
    const defaults = experiments.SWEEP_DEFAULTS[type];
    const start = Number(options.start ?? defaults.start);
    const end = Number(options.end ?? defaults.end);
    const rawStep = Math.abs(Number(options.step ?? defaults.step)) || defaults.step;
    const step = end >= start ? Math.abs(rawStep) : -Math.abs(rawStep);
    const delay = Math.max(100, Number(options.delay ?? defaults.delay));

    state.sweep = { type, running: true, start, end, step, delay, current: start };
    sweepReadFailures = 0;
    publish();

    const fromValue = type === 'angle' ? state.angle : state.fanSpeed;
    tick(moveActuator, fromValue, sweepToken);
    return { ok: true, sweep: state.sweep };
}

function startAngleSweep(options = {}) {
    return startSweep('angle', options, serial.setAngle);
}

function startFanSweep(options = {}) {
    return startSweep('fan', options, serial.setFanSpeed);
}

function stopSweep() {
    sweepToken += 1;
    if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
    if (state.sweep.running) {
        state.sweep = { ...state.sweep, running: false, current: state.sweep.start };
        publish();
    }
    // Logging stays open across repeated sweeps of the same experiment (see
    // main.js's ensureLoggingForSweep) -- it's only closed when the experiment
    // changes or the user explicitly stops it, not on every sweep stop.
    return { ok: true, sweep: state.sweep };
}

function status() {
    return state.sweep;
}

module.exports = { startSensorSampleTimer, startAngleSweep, startFanSweep, stopSweep, status, logPoint };
