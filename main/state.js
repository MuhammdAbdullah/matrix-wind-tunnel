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
    tapping: { channel: 1, increment: 1 },
    dragShape: 'Flat Surface',
    customAxes: { x: 'time', y: 'lift' },
    sweep: { type: null, running: false, start: 0, end: 0, step: 0, delay: 5000, current: 0 },
    logging: { active: false, path: null, rowCount: 0 },
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
