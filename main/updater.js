// Application updates via electron-updater / GitHub releases. Flow ported from
// Process Control V2: check -> "Download?" dialog -> download -> "Restart?" dialog.
const { app, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

const RELEASES_URL = 'https://github.com/MuhammdAbdullah/matrix-wind-tunnel/releases';
let getWindow = () => null;
let sendStatus = () => {};

autoUpdater.autoDownload = false; // let the user choose
autoUpdater.autoInstallOnAppQuit = false;

function emit(status) { sendStatus({ currentVersion: app.getVersion(), ...status }); }

autoUpdater.on('checking-for-update', () => emit({ state: 'checking', message: 'Checking for updates...' }));

autoUpdater.on('update-available', (info) => {
    emit({ state: 'available', version: info.version, message: `Version ${info.version} is available!` });
    const win = getWindow();
    dialog.showMessageBox(win || undefined, {
        type: 'info',
        title: 'Update Available',
        message: 'A new version is available!',
        detail: `Version ${info.version} is now available (you have ${app.getVersion()}). Would you like to download and install it?`,
        buttons: ['Yes', 'Later'],
        defaultId: 0,
        cancelId: 1
    }).then((result) => {
        if (result.response === 0) {
            emit({ state: 'downloading', percent: 0, message: 'Downloading update...' });
            autoUpdater.downloadUpdate().catch(() => {}); // failures arrive via the 'error' event
        }
    });
});

autoUpdater.on('update-not-available', () => emit({ state: 'current', message: `You are using the latest version (${app.getVersion()}).` }));

autoUpdater.on('error', (error) => {
    let message = `Error checking for updates: ${error.message}`;
    if (error.message && (error.message.includes('app-update.yml') || error.message.includes('ENOENT'))) {
        message = `Auto-updates are not supported for this install. Download the latest version from ${RELEASES_URL}`;
    }
    emit({ state: 'error', message });
});

autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress.percent);
    emit({ state: 'downloading', percent, message: `Downloading: ${percent}% (${Math.round(progress.bytesPerSecond / 1024)} KB/s)` });
});

autoUpdater.on('update-downloaded', (info) => {
    emit({ state: 'downloaded', version: info.version, message: 'Update downloaded successfully! Ready to install.' });
    dialog.showMessageBox(getWindow() || undefined, {
        type: 'info',
        title: 'Update Ready',
        message: 'Update downloaded successfully!',
        detail: 'The application will restart to apply the update. The tunnel is set to a safe state (fan 0, motor zero) first.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1
    }).then((result) => {
        if (result.response === 0) autoUpdater.quitAndInstall();
    });
});

ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) {
        const message = 'Update checking is only available in the installed application, not when running from source.';
        emit({ state: 'error', message });
        return { ok: false, message };
    }
    try {
        await autoUpdater.checkForUpdates();
        return { ok: true, currentVersion: app.getVersion() };
    } catch (error) {
        return { ok: false, message: error.message }; // also reported via the 'error' event
    }
});

function init(windowGetter, send) {
    getWindow = windowGetter;
    sendStatus = send;
}

module.exports = { init };
