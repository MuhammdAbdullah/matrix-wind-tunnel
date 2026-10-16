const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');

const { state, setMainWindow, publish, audit, simulateSensors } = require('./main/state');
const serial = require('./main/serial');
const admin = require('./main/admin');
const experiments = require('./main/experiments');
const sweeps = require('./main/sweeps');
const calibration = require('./main/calibration');
const firmware = require('./main/firmware');
const logging = require('./main/logging');

let mainWindow;

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
    setMainWindow(mainWindow);
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('device:getState', () => state);
ipcMain.handle('device:listPorts', () => serial.listPorts());
ipcMain.handle('device:connectPort', (_event, portPath, baudRate = 115200) => serial.connectHardware(portPath, baudRate));
ipcMain.handle('device:disconnect', () => { serial.disconnect(); return state; });
ipcMain.handle('device:setFanSpeed', (_event, value) => serial.setFanSpeed(value, { source: 'control' }));
ipcMain.handle('device:setAngle', (_event, value) => serial.setAngle(value, { source: 'control' }));
ipcMain.handle('device:zeroSensors', async () => {
    if (!state.simulation) await serial.sendBinary('F', Buffer.alloc(0), { source: 'control' });
    return { ok: true, message: 'Sensor zero command queued' };
});
ipcMain.handle('device:zeroMotor', async () => {
    if (!state.simulation) await serial.sendBinary('G', Buffer.alloc(0), { source: 'control' });
    state.angle = 0;
    publish();
    return state;
});
ipcMain.handle('device:sendCommand', async (_event, command, payload = []) => {
    const bytes = Buffer.from(payload);
    if (state.simulation) return { ok: true, command, simulation: true };
    const response = await serial.sendBinary(command, bytes, { source: 'control' });
    return { ok: true, command, response: [...response] };
});
ipcMain.handle('device:getDiagnostics', () => state.diagnostics);

ipcMain.handle('experiment:list', () => ({ experiments: experiments.EXPERIMENTS, dragShapes: experiments.DRAG_SHAPES }));
ipcMain.handle('experiment:select', (_event, experimentId) => {
    state.experimentId = experiments.getById(experimentId).id;
    state.tapping = { channel: 1, increment: 1 };
    publish();
    return { experimentId: state.experimentId };
});
ipcMain.handle('experiment:setTapping', (_event, { channel, increment }) => {
    if (channel !== undefined) state.tapping.channel = Math.min(23, Math.max(1, Number(channel) || 1));
    if (increment !== undefined) state.tapping.increment = Math.min(6, Math.max(0, Number(increment) || 0));
    publish();
    return state.tapping;
});
ipcMain.handle('experiment:setCustomAxes', (_event, { xField, yField }) => {
    state.customAxes = { x: xField || state.customAxes.x, y: yField || state.customAxes.y };
    publish();
    return state.customAxes;
});
ipcMain.handle('experiment:setDragShape', (_event, shape) => {
    if (experiments.DRAG_SHAPES.includes(shape)) state.dragShape = shape;
    publish();
    return state.dragShape;
});

ipcMain.handle('sweep:startAngle', (_event, options = {}) => sweeps.startAngleSweep(options));
ipcMain.handle('sweep:startFan', (_event, options = {}) => sweeps.startFanSweep(options));
ipcMain.handle('sweep:stop', () => sweeps.stopSweep());
ipcMain.handle('sweep:status', () => sweeps.status());

ipcMain.handle('log:start', () => logging.startLog(experiments.getById(state.experimentId)));
ipcMain.handle('log:stop', () => logging.stopLog());
ipcMain.handle('log:status', () => logging.status());
ipcMain.handle('log:setFolder', (_event, folder) => logging.setLogsFolder(folder));

ipcMain.handle('calibration:setScaler', (_event, payload) => calibration.setScaler(payload));
ipcMain.handle('calibration:getScalers', () => calibration.getScalers());
ipcMain.handle('calibration:setLutEntry', (_event, payload) => calibration.setLutEntry(payload));
ipcMain.handle('calibration:getLut', () => calibration.getLut());
ipcMain.handle('calibration:calibrateDisplay', () => calibration.calibrateDisplay());
ipcMain.handle('calibration:setNetwork', (_event, payload) => calibration.setNetwork(payload));

ipcMain.handle('admin:firmware', (_event, payload) => firmware.handleAction(payload));
ipcMain.handle('admin:status', () => admin.status());
ipcMain.handle('admin:verify', (_event, password) => admin.verify(password));
ipcMain.handle('admin:setup', (_event, password) => admin.setup(password));
ipcMain.handle('admin:lock', () => { admin.lock(); publish(); return { ok: true }; });
ipcMain.handle('admin:getAuditLog', () => audit.slice(-50));
ipcMain.handle('admin:requestElevation', async () => {
    await dialog.showMessageBox({ type: 'info', title: 'Windows administrator approval', message: 'Firmware operations must be performed by an elevated helper and are disabled in this build.' });
    return false;
});

app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createWindow();
    if (state.simulation) {
        state.port = 'Simulation';
        state.connected = true;
        simulateSensors();
        publish();
    } else {
        serial.startAutoConnect();
    }
    sweeps.startSensorSampleTimer();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

module.exports = { USB_VENDOR_ID: serial.USB_VENDOR_ID, USB_PRODUCT_ID: serial.USB_PRODUCT_ID };
