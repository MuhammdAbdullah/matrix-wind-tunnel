const { state, publish, clamp } = require('./state');
const serial = require('./serial');
const logging = require('./logging');
const experiments = require('./experiments');

const DEFAULT_SAMPLE_TIME_MS = 1000;
// Standard sea-level air density (kg/m^3), matching the value used throughout the April 2023
// "Wind Tunnel - Test results" report's own Cp/Cd calculations (the worksheet text rounds to
// 1.20; the verified test data uses 1.225/1.223 -- use the more precise, test-verified value).
const AIR_DENSITY = 1.225;
// Readings are matched to a calibration point within this many percentage points of fan speed
// (the pitot-static worksheet is run in 10% steps, so an exact or near-exact match is normal;
// this just tolerates small operator rounding, e.g. 49% vs a 50% calibration point).
const FREE_STREAM_MATCH_TOLERANCE = 3;

let sensorTimer = null;
let sweepTimer = null;

serial.onUnexpectedDisconnect(() => stopSweep());

function startSensorSampleTimer(sampleTimeMs = DEFAULT_SAMPLE_TIME_MS) {
    if (sensorTimer) clearInterval(sensorTimer);
    sensorTimer = setInterval(async () => {
        if (state.simulation) return; // renderer-visible simulated sensors are driven elsewhere
        if (state.sweep.running) return; // the active sweep's own tick already reads+logs each cycle
        try {
            await serial.readSensorsOnce({ source: 'system' });
            serial.reportReadOutcome(true);
            publish();
        } catch (_error) {
            serial.reportReadOutcome(false);
            state.diagnostics.errors += 1;
            publish();
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
    }, sampleTimeMs);
}

// Finds the pitot-static free-stream pressure logged nearest the given fan speed (see
// recordFreeStreamCalibration()). Returns null if no calibration point is close enough --
// callers must not silently treat "no calibration yet" as P_inf = 0.
function lookupFreeStreamPressure(fanSpeed) {
    const table = state.calibration.pressureByFanSpeed;
    const keys = Object.keys(table).map(Number);
    if (!keys.length) return null;
    const nearest = keys.reduce((best, key) => (Math.abs(key - fanSpeed) < Math.abs(best - fanSpeed) ? key : best));
    if (Math.abs(nearest - fanSpeed) > FREE_STREAM_MATCH_TOLERANCE) return null;
    return table[nearest];
}

// Cp = (P - P_inf) / (0.5 * rho * V^2), per Worksheets 2 and 3. Returns { cp, freeStreamPressure }
// with cp: null when there's no usable calibration point or the tunnel isn't moving yet (V=0
// would otherwise divide by zero) -- the UI must show this as "uncalibrated", not a false 0.
function computeCp(pressure, fanSpeed, velocity) {
    const freeStreamPressure = lookupFreeStreamPressure(fanSpeed);
    if (freeStreamPressure === null || !velocity) return { cp: null, freeStreamPressure: null };
    const cp = (pressure - freeStreamPressure) / (0.5 * AIR_DENSITY * velocity * velocity);
    return { cp: Number(cp.toFixed(4)), freeStreamPressure };
}

// The pitot-static worksheet ("Convert Pressure to Velocity") IS the free-stream calibration
// run: each logged point records the undisturbed tunnel pressure at a given fan speed, which
// Worksheets 2/3 then reuse as P_inf. Keyed by the fan speed active at log time so Pressure
// Tapped Cylinder/Aerofoil readings taken at a matching fan speed can look it back up.
function recordFreeStreamCalibration() {
    state.calibration.pressureByFanSpeed[state.fanSpeed] = state.sensors.pressure;
}

function buildRow(experiment) {
    // Pressure Tapped Aerofoil splits its single pressure reading across two chart/CSV
    // traces by tapping channel (top surface 1-12, bottom surface 13-23; channel 1 is the
    // shared reference point and belongs to both) -- mirrors the legacy source's two
    // Chart_XY.AddPoint() calls for that experiment.
    const channel = state.tapping.channel;
    const { cp, freeStreamPressure } = computeCp(state.sensors.pressure, state.fanSpeed, state.sensors.velocity);
    const row = {
        time: new Date().toISOString(),
        fanSpeed: state.fanSpeed,
        angle: state.angle,
        manualAngle: state.manualAngle.current,
        aerofoilAoA: state.aerofoilAoA,
        lift: state.sensors.lift,
        drag: state.sensors.drag,
        pressure: state.sensors.pressure,
        pressureTop: channel <= 12 ? state.sensors.pressure : null,
        pressureBottom: channel === 1 || channel > 12 ? state.sensors.pressure : null,
        velocity: state.sensors.velocity,
        tappingChannel: channel,
        dragShape: state.dragShape,
        freeStreamPressure,
        cp,
        cpTop: channel <= 12 ? cp : null,
        cpBottom: channel === 1 || channel > 12 ? cp : null
    };
    if (experiment.id === 'pressureTappedAerofoil') {
        const { x, surface } = experiments.chordPositionFor(channel);
        row.chordX = x;
        row.surface = surface;
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
    if (experiment.id === 'pressureToVelocity') recordFreeStreamCalibration();
    advanceTapping(experiment);
    advanceManualAngle(experiment);
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

// Pressure Tapped Cylinder never drives the motor -- the operator hand-rotates it and this
// counter just tracks the equivalent angle, wrapping +180 -> -180, once per logged point.
function advanceManualAngle(experiment) {
    if (!experiment.fields.includes('manualAngle') || !state.manualAngle.increment) return;
    const next = state.manualAngle.current + state.manualAngle.increment;
    state.manualAngle.current = next > 180 ? -180 : next;
}

// Drag Coefficient has no sweep switch in the legacy source -- the operator sets fan speed,
// clicks Log, and the gauge itself auto-bumps by "Increment Speed" (wrapping 100 -> 0) as a
// convenience for the next click. Unlike manualAngle this drives the real hardware value.
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
async function tick(moveActuator, fromValue) {
    const target = state.sweep.current;
    await moveActuator(target, { source: 'control' });
    if (!state.sweep.running) return; // stopped while the move was in flight

    const distance = Math.abs(target - fromValue);
    const normalStep = Math.abs(state.sweep.step) || 1;
    const settleDelay = Math.max(state.sweep.delay, Math.round(state.sweep.delay * (distance / normalStep)));

    sweepTimer = setTimeout(async () => {
        if (!state.sweep.running) return; // stopped during the settle wait

        try {
            await serial.readSensorsOnce({ source: 'control' });
            serial.reportReadOutcome(true);
        } catch (_error) {
            serial.reportReadOutcome(false);
            state.diagnostics.errors += 1;
        }
        const experiment = experiments.getById(state.experimentId);
        if (state.logging.active) {
            logging.appendRow(buildRow(experiment));
            advanceTapping(experiment);
            advanceManualAngle(experiment);
        }
        publish();

        const reachedEnd = state.sweep.step > 0 ? state.sweep.current >= state.sweep.end : state.sweep.current <= state.sweep.end;
        if (reachedEnd) {
            stopSweep();
            return;
        }
        state.sweep.current += state.sweep.step;
        tick(moveActuator, target);
    }, settleDelay);
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

    const fromValue = type === 'angle' ? state.angle : state.fanSpeed;
    tick(moveActuator, fromValue);
    return { ok: true, sweep: state.sweep };
}

function startAngleSweep(options = {}) {
    return startSweep('angle', options, serial.setAngle);
}

function startFanSweep(options = {}) {
    return startSweep('fan', options, serial.setFanSpeed);
}

function stopSweep() {
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
