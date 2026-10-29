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
const updater = require('./main/updater');
const control = require('./main/control');
const network = require('./main/network');

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
    mainWindow.webContents.on('before-input-event', (_event, input) => {
        if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
            mainWindow.webContents.toggleDevTools();
        }
    });
    setMainWindow(mainWindow);
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('device:getState', () => state);
ipcMain.handle('device:listPorts', () => serial.listPorts());
ipcMain.handle('device:connectPort', (_event, portPath, baudRate = 115200) => serial.connectHardware(portPath, baudRate));
ipcMain.handle('device:disconnect', async () => {
    if (state.transport === 'remote') { await network.disconnectRemote(); return state; }
    // Stop first: the auto-scan reconnects within seconds and a surviving sweep would drive the fan on the new session.
    sweeps.stopSweep();
    serial.disconnect();
    return state;
});
// Fan/angle/LED/zero go through main/control.js, which forwards them to the master when this app is a
// remote client and otherwise runs them against the local hardware link.
ipcMain.handle('device:setFanSpeed', (_event, value) => control.setFanSpeed(value));
ipcMain.handle('device:setAngle', (_event, value) => control.setAngle(value));
ipcMain.handle('device:setLeds', (_event, payload) => control.setLeds(payload));
ipcMain.handle('device:zeroSensors', () => control.zeroSensors());
ipcMain.handle('device:zeroMotor', () => control.zeroMotor());
ipcMain.handle('device:sendCommand', async (_event, command, payload = []) => {
    const bytes = Buffer.from(payload);
    if (state.simulation) return { ok: true, command, simulation: true };
    const response = await serial.sendBinary(command, bytes, { source: 'control' });
    return { ok: true, command, response: [...response] };
});
ipcMain.handle('device:getDiagnostics', () => state.diagnostics);

ipcMain.handle('experiment:list', () => ({ experiments: experiments.EXPERIMENTS, dragShapes: experiments.DRAG_SHAPES }));
ipcMain.handle('experiment:select', (_event, experimentId) => {
    // Switching experiments ends the current log -- the next sweep for the
    // newly selected experiment must prompt for a fresh save location/name.
    if (state.logging.active && state.logging.experimentId !== experimentId) logging.stopLog();
    state.experimentId = experiments.getById(experimentId).id;
    state.tapping = { channel: 1, increment: 1 };
    state.aerofoilAngle = 0;
    state.manualAngle = { increment: 5 };
    publish();
    return { experimentId: state.experimentId };
});
ipcMain.handle('experiment:setTapping', (_event, { channel }) => {
    if (channel !== undefined) state.tapping.channel = Math.min(23, Math.max(1, Number(channel) || 1));
    publish();
    return state.tapping;
});
ipcMain.handle('experiment:setAerofoilAngle', (_event, value) => {
    state.aerofoilAngle = Math.min(45, Math.max(-45, Number(value) || 0));
    publish();
    return state.aerofoilAngle;
});
ipcMain.handle('experiment:setManualAngleIncrement', (_event, increment) => {
    state.manualAngle.increment = Math.min(45, Math.max(0, Number(increment) || 0));
    publish();
    return state.manualAngle;
});
ipcMain.handle('experiment:setFanSpeedIncrement', (_event, increment) => {
    state.fanSpeedIncrement = Math.min(25, Math.max(0, Number(increment) || 0));
    publish();
    return state.fanSpeedIncrement;
});
ipcMain.handle('experiment:setStemRacingChartType', (_event, chartType) => {
    state.stemRacingChartType = Math.min(2, Math.max(0, Number(chartType) || 0));
    publish();
    return state.stemRacingChartType;
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

// Shared by log:start and the sweep starters below so every experiment type
// (not just the no-sweep ones that only use the "Start log" button) is asked
// where to save and what to name its CSV before any points are recorded.
async function startLogWithDialog(experiment) {
    const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Experiment Log',
        defaultPath: path.join(logging.getLogsFolder(), logging.defaultLogName(experiment)),
        filters: [
            { name: 'CSV Files', extensions: ['csv'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    return logging.startLog(experiment, result.filePath);
}

// Repeated sweeps of the *same* experiment share one CSV (a blank-line-
// separated block per sweep) and only prompt for a save location once;
// a different experiment always gets a fresh prompt (experiment:select
// above already closed out the old file in that case).
async function ensureLoggingForSweep(experiment) {
    if (state.logging.active && state.logging.experimentId === experiment.id) {
        logging.startSweepBlock();
        return { ok: true };
    }
    if (state.logging.active) logging.stopLog();
    const logResult = await startLogWithDialog(experiment);
    if (logResult.canceled) return { ok: false, canceled: true, message: 'Save location cancelled; sweep not started' };
    if (!logResult.ok) return { ok: false, message: 'Failed to start logging' };
    return { ok: true };
}

const NOT_CONNECTED = { ok: false, message: 'Controller not connected; sweep not started' };
// Sweeps, experiment logging and calibration run on the machine that owns the hardware link.
const REMOTE_REFUSAL = { ok: false, message: 'Sweeps and logging run on the master PC. Use the master to start them.' };

ipcMain.handle('sweep:startAngle', async (_event, options = {}) => {
    if (state.transport === 'remote') return REMOTE_REFUSAL;
    if (!state.connected) return NOT_CONNECTED;
    const experiment = experiments.getById(state.experimentId);
    const ensured = await ensureLoggingForSweep(experiment);
    if (!ensured.ok) return ensured;
    return sweeps.startAngleSweep(options);
});
ipcMain.handle('sweep:startFan', async (_event, options = {}) => {
    if (state.transport === 'remote') return REMOTE_REFUSAL;
    if (!state.connected) return NOT_CONNECTED;
    const experiment = experiments.getById(state.experimentId);
    const ensured = await ensureLoggingForSweep(experiment);
    if (!ensured.ok) return ensured;
    return sweeps.startFanSweep(options);
});
ipcMain.handle('sweep:stop', () => (state.transport === 'remote' ? network.remoteCommand('stopSweep', []) : sweeps.stopSweep()));
ipcMain.handle('sweep:status', () => sweeps.status());

ipcMain.handle('log:start', () => (state.transport === 'remote' ? REMOTE_REFUSAL : startLogWithDialog(experiments.getById(state.experimentId))));
ipcMain.handle('log:stop', () => logging.stopLog());
ipcMain.handle('log:status', () => logging.status());
ipcMain.handle('log:setFolder', (_event, folder) => logging.setLogsFolder(folder));
ipcMain.handle('experiment:logPoint', () => (state.transport === 'remote' ? REMOTE_REFUSAL : sweeps.logPoint()));

ipcMain.handle('calibration:setScaler', (_event, payload) => calibration.setScaler(payload));
ipcMain.handle('calibration:getScalers', () => calibration.getScalers());
ipcMain.handle('calibration:setLutTable', (_event, payload) => calibration.setLutTable(payload));
ipcMain.handle('calibration:getLut', () => calibration.getLut());
ipcMain.handle('calibration:setLutFan', (_event, payload) => calibration.setLutFan(payload));
ipcMain.handle('calibration:calibrateDisplay', () => calibration.calibrateDisplay());
ipcMain.handle('calibration:setNetwork', (_event, payload) => calibration.setNetwork(payload));

// Network settings are Admin-only and re-checked here, not just in the renderer.
const adminOnly = (handler) => (...args) => (admin.isUnlocked() ? handler(...args) : { ok: false, message: 'Admin session is locked.' });
ipcMain.handle('network:getSettings', adminOnly(() => ({ ok: true, ...network.getSettings() })));
ipcMain.handle('network:saveEthernet', adminOnly((_event, payload) => network.saveEthernetSettings(payload || {})));
ipcMain.handle('network:saveRelay', adminOnly((_event, payload) => network.saveRelaySettings(payload || {})));
ipcMain.handle('network:regenerateCode', adminOnly(() => network.regenerateAccessCode()));
ipcMain.handle('network:scan', adminOnly((_event, port) => network.scanNetwork(port)));
ipcMain.handle('network:connectRemote', adminOnly((_event, payload) => network.connectRemote(payload || {})));
ipcMain.handle('network:disconnectRemote', adminOnly(() => network.disconnectRemote()));

ipcMain.handle('admin:firmwareInfo', () => ({ version: firmware.APPROVED_FIRMWARE_VERSION }));
ipcMain.handle('admin:bootloaderPickHex', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Select firmware hex file', filters: [{ name: 'Hex Files', extensions: ['hex'] }], properties: ['openFile'] });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
});
ipcMain.handle('admin:bootloaderTrigger', () => firmware.triggerBootloader());
ipcMain.handle('admin:bootloaderCheckDevice', (_event, vid, pid) => firmware.checkDevice(vid, pid));
ipcMain.handle('admin:bootloaderConnect', (_event, vid, pid) => firmware.connect(vid, pid));
ipcMain.handle('admin:bootloaderDisconnect', () => firmware.disconnect());
ipcMain.handle('admin:bootloaderLoadHex', (_event, hexPath) => firmware.loadHex(hexPath));
ipcMain.handle('admin:bootloaderReadInfo', () => firmware.readInfo());
ipcMain.handle('admin:bootloaderErase', () => firmware.erase());
ipcMain.handle('admin:bootloaderProgram', () => firmware.program());
ipcMain.handle('admin:bootloaderReadCrc', () => firmware.readCrc());
ipcMain.handle('admin:bootloaderJumpToApp', () => firmware.jumpToApp());
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
    updater.init(
        () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
        (status) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', status); }
    );
    if (state.simulation) {
        state.port = 'Simulation';
        state.connected = true;
        simulateSensors();
        publish();
    } else {
        serial.startAutoConnect();
    }
    network.init();
    sweeps.startSensorSampleTimer();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
// Bring the tunnel to a safe condition (fan 0, motor at zero) before the process exits.
let shutdownSafe = false;
app.on('before-quit', (event) => {
    if (shutdownSafe) return;
    event.preventDefault();
    shutdownSafe = true;
    sweeps.stopSweep();
    network.shutdown();
    Promise.race([
        serial.enterSafeState('system', { preempt: true }),
        new Promise((resolve) => setTimeout(resolve, 5000))
    ]).catch(() => {}).then(() => serial.closeLink()).catch(() => {}).finally(() => app.quit());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

module.exports = { USB_VENDOR_ID: serial.USB_VENDOR_ID, USB_PRODUCT_ID: serial.USB_PRODUCT_ID };
