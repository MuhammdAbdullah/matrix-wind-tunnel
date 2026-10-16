const { app, BrowserWindow, ipcMain, safeStorage, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let SerialPort;
try { ({ SerialPort } = require('serialport')); } catch (_error) { SerialPort = null; }

const USB_VENDOR_ID = 0x12BF;
const USB_PRODUCT_ID = 0xF010;
const API_VERSION = 2;

let mainWindow;
let serialPort = null;
let serialBuffer = Buffer.alloc(0);
let commandQueue = Promise.resolve();
let pendingCommand = null;
const appDataPath = () => path.join(app.getPath('userData'), 'wind-tunnel-admin.json');
let state = {
    connected: false,
    simulation: process.argv.includes('--simulate') || process.env.WIND_TUNNEL_SIMULATION === '1',
    port: null,
    apiVersion: API_VERSION,
    fanSpeed: 0,
    angle: 0,
    sensors: { lift: 0, drag: 0, pressure: 0, velocity: 0 },
    diagnostics: { tx: [], rx: [], retries: 0, errors: 0 }
};

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1480,
        height: 940,
        minWidth: 1100,
        minHeight: 720,
        backgroundColor: '#08111c',
        icon: path.join(__dirname, 'assets', 'icon.ico'),
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function publish() {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state:update', state);
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }

function frame(command, payload = Buffer.alloc(0)) { return Buffer.concat([Buffer.from(':'), Buffer.from(command), payload, Buffer.from(';\n')]); }
function parseFrames(chunk) {
    serialBuffer = Buffer.concat([serialBuffer, chunk]);
    const frames = [];
    while (true) {
        const start = serialBuffer.indexOf(0x3A);
        if (start < 0) { serialBuffer = Buffer.alloc(0); break; }
        const end = serialBuffer.indexOf(Buffer.from(';\n'));
        if (end < 0) { serialBuffer = serialBuffer.subarray(start); break; }
        frames.push(serialBuffer.subarray(start, end + 1));
        serialBuffer = serialBuffer.subarray(end + 2);
    }
    return frames;
}
function record(direction, data) { state.diagnostics[direction].push(`${new Date().toISOString()} ${data.toString('hex')}`); state.diagnostics[direction] = state.diagnostics[direction].slice(-100); publish(); }
function sendBinary(command, payload = Buffer.alloc(0), timeout = 2000) {
    commandQueue = commandQueue.then(() => new Promise((resolve, reject) => {
        if (!serialPort || !serialPort.isOpen) { reject(new Error('Controller is not connected')); return; }
        const packet = frame(command, payload); pendingCommand = { command, resolve, reject, timer: setTimeout(() => { pendingCommand = null; state.diagnostics.retries += 1; reject(new Error(`Timeout waiting for ${command}`)); }, timeout) };
        record('tx', packet);
        serialPort.write(packet, (error) => { if (error && pendingCommand) { clearTimeout(pendingCommand.timer); pendingCommand.reject(error); pendingCommand = null; } });
    }));
    return commandQueue;
}
function parseResponse(response) {
    if (response[0] !== 0x3A || !pendingCommand || response[1] !== pendingCommand.command.charCodeAt(0)) return;
    const payload = response.subarray(2, response.length - 1);
    const request = pendingCommand; pendingCommand = null; clearTimeout(request.timer); request.resolve(payload);
}
function readAdminRecord() { try { return JSON.parse(fs.readFileSync(appDataPath(), 'utf8')); } catch (_error) { return null; } }
function saveAdminRecord(recordValue) { fs.mkdirSync(path.dirname(appDataPath()), { recursive: true }); fs.writeFileSync(appDataPath(), JSON.stringify(recordValue), { mode: 0o600 }); }
function hashPassword(password, salt = crypto.randomBytes(16)) { return { salt: salt.toString('base64'), hash: crypto.scryptSync(password, salt, 32).toString('base64') }; }
function verifyPassword(password, recordValue) { const actual = crypto.scryptSync(password, Buffer.from(recordValue.salt, 'base64'), 32); return crypto.timingSafeEqual(actual, Buffer.from(recordValue.hash, 'base64')); }

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
    state.connected = true; state.port = 'Simulation'; publish(); return state;
});
ipcMain.handle('device:listPorts', async () => SerialPort ? SerialPort.list() : []);
ipcMain.handle('device:connectPort', async (_event, portPath, baudRate = 115200) => {
    if (!SerialPort) throw new Error('SerialPort dependency is not installed');
    if (serialPort?.isOpen) await new Promise((resolve) => serialPort.close(resolve));
    serialPort = new SerialPort({ path: portPath, baudRate, autoOpen: false });
    serialPort.on('data', (chunk) => { record('rx', chunk); parseFrames(chunk).forEach(parseResponse); });
    serialPort.on('error', () => { state.diagnostics.errors += 1; publish(); });
    await new Promise((resolve, reject) => serialPort.open((error) => error ? reject(error) : resolve()));
    state.connected = true; state.simulation = false; state.port = portPath; publish();
    const version = await sendBinary('A');
    if (!version.length || version[0] !== API_VERSION) { await new Promise((resolve) => serialPort.close(resolve)); serialPort = null; state.connected = false; throw new Error(`Unsupported controller API version: ${version[0] ?? 'unknown'}`); }
    return state;
});
ipcMain.handle('device:disconnect', () => {
    if (serialPort?.isOpen) serialPort.close(); serialPort = null;
    state.connected = false;
    state.port = null;
    state.simulation = false;
    state.fanSpeed = 0;
    simulateSensors();
    return state;
});
ipcMain.handle('device:setFanSpeed', (_event, value) => {
    state.fanSpeed = clamp(value, 0, 100);
    if (!state.simulation) sendBinary('B', Buffer.from([state.fanSpeed])).catch((error) => { state.diagnostics.errors += 1; publish(); });
    else simulateSensors();
    return state;
});
ipcMain.handle('device:setAngle', (_event, value) => {
    state.angle = clamp(value, -180, 180);
    if (!state.simulation) { const payload = Buffer.alloc(2); payload.writeInt16LE(state.angle); sendBinary('D', payload).catch(() => { state.diagnostics.errors += 1; publish(); }); }
    else simulateSensors();
    return state;
});
ipcMain.handle('device:zeroSensors', async () => { if (!state.simulation) await sendBinary('F'); return { ok: true, message: 'Sensor zero command queued' }; });
ipcMain.handle('device:zeroMotor', async () => {
    if (!state.simulation) await sendBinary('G');
    state.angle = 0;
    publish();
    return state;
});
ipcMain.handle('device:sendCommand', async (_event, command, payload = []) => {
    const bytes = Buffer.from(payload);
    if (state.simulation) return { ok: true, command, simulation: true };
    const response = await sendBinary(command, bytes);
    return { ok: true, command, response: [...response] };
});
ipcMain.handle('device:getDiagnostics', () => state.diagnostics);
ipcMain.handle('admin:calibration', (_event, payload) => ({ ok: true, message: `${payload.action} acknowledged in simulation` }));
ipcMain.handle('admin:firmware', () => ({ ok: false, message: 'Firmware flashing requires the approved loader and Windows elevation.' }));
ipcMain.handle('admin:status', () => ({ configured: Boolean(readAdminRecord()), secureStorage: safeStorage.isEncryptionAvailable() }));
ipcMain.handle('admin:verify', (_event, password) => {
    const existing = readAdminRecord();
    if (!existing) return { ok: false, needsSetup: true };
    return { ok: verifyPassword(password, existing) };
});
ipcMain.handle('admin:setup', (_event, password) => {
    if (!password || password.length < 8) return { ok: false, message: 'Use at least 8 characters.' };
    saveAdminRecord(hashPassword(password)); return { ok: true };
});
ipcMain.handle('admin:requestElevation', async () => { await dialog.showMessageBox({ type: 'info', title: 'Windows administrator approval', message: 'Firmware operations must be performed by an elevated helper and are disabled in this build.' }); return false; });

app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createWindow();
    if (state.simulation) { state.port = 'Simulation'; state.connected = true; publish(); }
    else startAutoConnect();
    setInterval(async () => {
        if (state.simulation) simulateSensors();
        else if (serialPort?.isOpen) { try { const payload = await sendBinary('C'); if (payload.length >= 16) { state.sensors = { lift: payload.readFloatLE(0), drag: payload.readFloatLE(4), pressure: payload.readFloatLE(8), velocity: payload.readFloatLE(12) }; publish(); } } catch (_error) { state.diagnostics.errors += 1; publish(); } }
    }, 1000);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

let autoConnectTimer;
let autoConnectBusy = false;
async function startAutoConnect() {
    const scan = async () => {
        if (autoConnectBusy || state.connected || !SerialPort) return;
        autoConnectBusy = true;
        try {
            const ports = await SerialPort.list();
            const target = ports.find((port) => String(port.vendorId || '').toUpperCase() === '12BF' && String(port.productId || '').toUpperCase() === 'F010');
            if (target) {
                try { await connectHardware(target.path, 115200); } catch (error) { state.diagnostics.errors += 1; publish(); }
            }
        } finally { autoConnectBusy = false; }
    };
    await scan();
    autoConnectTimer = setInterval(scan, 2000);
}
async function connectHardware(portPath, baudRate) {
    if (!SerialPort) throw new Error('SerialPort dependency is not installed');
    if (serialPort?.isOpen) await new Promise((resolve) => serialPort.close(resolve));
    serialPort = new SerialPort({ path: portPath, baudRate, autoOpen: false });
    serialPort.on('data', (chunk) => { record('rx', chunk); parseFrames(chunk).forEach(parseResponse); });
    serialPort.on('error', () => { state.diagnostics.errors += 1; publish(); });
    serialPort.on('close', () => { state.connected = false; state.port = null; publish(); });
    await new Promise((resolve, reject) => serialPort.open((error) => error ? reject(error) : resolve()));
    state.connected = true; state.simulation = false; state.port = portPath; publish();
    const version = await sendBinary('A');
    if (!version.length || version[0] !== API_VERSION) throw new Error(`Unsupported controller API version: ${version[0] ?? 'unknown'}`);
    return state;
}

module.exports = { USB_VENDOR_ID, USB_PRODUCT_ID };
