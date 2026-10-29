const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Shares wind-tunnel-config.json with logging.js (logsFolder); every write merges into the existing
// file so neither module clobbers the other's keys.
const configPath = () => path.join(app.getPath('userData'), 'wind-tunnel-config.json');

function readConfig() {
    try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (_error) { return {}; }
}

function updateConfig(patch) {
    const config = { ...readConfig(), ...patch };
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config), { mode: 0o600 });
    return config;
}

module.exports = { readConfig, updateConfig };
