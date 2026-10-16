const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { state, publish, pushEvent } = require('./state');

const configPath = () => path.join(app.getPath('userData'), 'wind-tunnel-config.json');
const defaultLogsFolder = () => path.join(app.getPath('documents'), 'Wind Tunnel', 'Logs');

let currentStream = null;
let currentPath = null;
let rowCount = 0;
let activeColumns = [];

function readConfig() {
    try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (_error) { return {}; }
}

function getLogsFolder() {
    const config = readConfig();
    return config.logsFolder || defaultLogsFolder();
}

function setLogsFolder(folder) {
    const config = readConfig();
    config.logsFolder = folder;
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config));
    return { ok: true, logsFolder: folder };
}

function startLog(experiment) {
    if (currentStream) stopLog();
    const folder = getLogsFolder();
    fs.mkdirSync(folder, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    currentPath = path.join(folder, `WindTunnelLog_${timestamp}.csv`);
    currentStream = fs.createWriteStream(currentPath, { flags: 'a' });
    activeColumns = experiment.csvColumns;
    currentStream.write(`${activeColumns.join(',')}\n`);
    rowCount = 0;
    state.logging = { active: true, path: currentPath, rowCount: 0 };
    publish();
    return { ok: true, path: currentPath };
}

function appendRow(rowObject) {
    if (!currentStream) return;
    const line = activeColumns.map((column) => (rowObject[column] ?? '')).join(',');
    currentStream.write(`${line}\n`);
    rowCount += 1;
    state.logging.rowCount = rowCount;
    pushEvent('log:event', { rowCount, path: currentPath });
}

function stopLog() {
    if (currentStream) { currentStream.end(); currentStream = null; }
    const result = { ok: true, rowCount, path: currentPath };
    state.logging = { active: false, path: null, rowCount: 0 };
    publish();
    return result;
}

function status() {
    return { ...state.logging, logsFolder: getLogsFolder() };
}

module.exports = { startLog, appendRow, stopLog, status, setLogsFolder, getLogsFolder };
