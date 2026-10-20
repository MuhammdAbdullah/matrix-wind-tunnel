const API_VERSION = 2;
const AUDIT_LIMIT = 200;

let mainWindow = null;

function setMainWindow(win) {
    mainWindow = win;
}

const state = {
    connected: false,
    simulation: process.argv.includes('--simulate') || process.env.WIND_TUNNEL_SIMULATION === '1',
    port: null,
    apiVersion: API_VERSION,
    fanSpeed: 0,
    angle: 0,
    sensors: { lift: 0, drag: 0, pressure: 0, velocity: 0 },
    diagnostics: { tx: [], rx: [], retries: 0, errors: 0 },
    experimentId: 'sensorsVsTime',
    // Tapping channel auto-advances by 1 per Log Point (legacy default); there is no operator-set increment.
    tapping: { channel: 1, increment: 1 },
    // Aerofoil angle of attack, typed in by the operator (the aerofoil is turned by hand). Saved with
    // every logged row and used to name the run on the chart.
    aerofoilAngle: 0,
    manualAngle: { increment: 5 },
    dragShape: 'Flat Surface',
    fanSpeedIncrement: 10,
    stemRacingChartType: 1, // 0 = vs Time, 1 = vs Air Speed, 2 = vs Fan Speed
    customAxes: { x: 'time', y: 'lift' },
    leds: {
        animMode: 3, // 0 Off, 1 Static, 2 Strobe, 3 Match speed (1/20th), 4 Match speed (actual)
        animColor: { r: 255, g: 40, b: 40 },
        ambMode: 2, // 0 Off, 1 Static, 2 Fade, 3 Waves
        ambColor: { r: 40, g: 107, b: 255 }
    },
    sweep: { type: null, running: false, start: 0, end: 0, step: 0, delay: 5000, current: 0 },
    // Bumped only when state.sensors is actually overwritten with a fresh reading --
    // serial.js's readSensorsOnce() (hardware) and this module's own simulateSensors()
    // (simulation) are the only two places sensors genuinely change. Every other publish
    // (fan/angle slider commit, LED write, experiment/tapping/drag-shape change, a
    // retry-exhausted setAngle/setFanSpeed error, etc.) still pushes state to the renderer,
    // but without a changed sensorSampleSeq -- the renderer uses that to tell a genuine new
    // sample from an unrelated publish, so it doesn't log a spurious duplicate chart point
    // pairing already-updated controls with still-stale sensor data.
    sensorSampleSeq: 0,
    // Bumped only by sweeps.js's logPoint() -- the discrete "Log Point" action used by the
    // manual-log experiments (pressureToVelocity, pressureTappedCylinder,
    // pressureTappedAerofoil, dragCoefficient, custom). The legacy Flowcode source's single
    // "Log" button adds exactly one chart point per click (plus a CSV row only if a log file
    // is open) and then auto-advances fan speed/manual angle/tapping channel for the next
    // click -- lastLoggedPoint/loggedPointSeq let the renderer mirror that discrete capture
    // instead of inferring history points from the continuous sensor-sample timer.
    loggedPointSeq: 0,
    lastLoggedPoint: null,
    logging: { active: false, path: null, rowCount: 0, experimentId: null },
    adminUnlocked: false
};

const audit = [];

function publish() {
    const admin = require('./admin');
    state.adminUnlocked = admin.isUnlocked();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state:update', state);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
}

function simulateSensors() {
    const fan = state.fanSpeed / 100;
    const radians = (state.angle * Math.PI) / 180;
    state.sensors = {
        lift: Number((fan * 180 * Math.sin(radians)).toFixed(2)),
        drag: Number((fan * 95 * (0.4 + Math.abs(Math.sin(radians)))).toFixed(2)),
        pressure: Number((fan * fan * 610).toFixed(2)),
        velocity: Number((fan * 22.8).toFixed(2))
    };
    state.sensorSampleSeq += 1;
    return state.sensors;
}

function appendAudit(entry) {
    audit.push({ timestamp: new Date().toISOString(), ...entry });
    if (audit.length > AUDIT_LIMIT) audit.shift();
    pushEvent('audit:update', audit.slice(-50));
}

function pushEvent(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

module.exports = { API_VERSION, state, setMainWindow, publish, clamp, simulateSensors, appendAudit, audit, pushEvent };
