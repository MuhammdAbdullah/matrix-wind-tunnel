const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const USB_VENDOR_ID = 0x12BF;
const USB_PRODUCT_ID = 0xF010;
const API_VERSION = 2;

let mainWindow;
let state = {
    connected: false,
    simulation: true,
    port: 'Simulation',
    apiVersion: API_VERSION,
    fanSpeed: 0,
    angle: 0,
    sensors: { lift: 0, drag: 0, pressure: 0, velocity: 0 }
};

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1480,
        height: 940,
        minWidth: 1100,
        minHeight: 720,
        backgroundColor: '#08111c',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function publish() {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state:update', state);
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }

function simulateSensors() {
    const fan = state.fanSpeed / 100;
    const radians = state.angle * Math.PI / 180;
    state.sensors = {
        lift: Number((fan * 180 * Math.sin(radians)).toFixed(2)),
        drag: Number((fan * 95 * (0.4 + Math.abs(Math.sin(radians)))).toFixed(2)),
        pressure: Number((fan * fan * 610).toFixed(2)),
        velocity: Number((fan * 22.8).toFixed(2))
    };
    publish();
}

ipcMain.handle('device:getState', () => state);
ipcMain.handle('device:connect', () => {
    state.connected = true;
    state.port = 'Simulation';
    publish();
    return state;
});
ipcMain.handle('device:disconnect', () => {
    state.connected = false;
    state.fanSpeed = 0;
    simulateSensors();
    return state;
});
ipcMain.handle('device:setFanSpeed', (_event, value) => {
    state.fanSpeed = clamp(value, 0, 100);
    simulateSensors();
    return state;
});
ipcMain.handle('device:setAngle', (_event, value) => {
    state.angle = clamp(value, -180, 180);
    simulateSensors();
    return state;
});
ipcMain.handle('device:zeroSensors', () => ({ ok: true, message: 'Sensor zero command queued' }));
ipcMain.handle('device:zeroMotor', () => {
    state.angle = 0;
    publish();
    return state;
});
ipcMain.handle('admin:calibration', (_event, payload) => ({ ok: true, message: `${payload.action} acknowledged in simulation` }));
ipcMain.handle('admin:firmware', () => ({ ok: false, message: 'Firmware flashing requires the approved loader and Windows elevation.' }));

app.whenReady().then(() => {
    createWindow();
    setInterval(simulateSensors, 1000);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

module.exports = { USB_VENDOR_ID, USB_PRODUCT_ID };
