const bootloader = require('./bootloader');
const admin = require('./admin');
const { pushEvent } = require('./state');
const path = require('path');

// Single place to bump when a new approved firmware image ships (files are named WindTunnel V<x.y.z>.hex).
const APPROVED_FIRMWARE_VERSION = '2.0.6';
const APPROVED_IMAGE_NAME = `WindTunnel V${APPROVED_FIRMWARE_VERSION}.hex`;

function progress(stage, level, message) {
    pushEvent('firmware:progress', { stage, level, message });
}

function guard() {
    if (!admin.isUnlocked()) return 'Admin session is locked. Unlock Admin before any firmware operation.';
    return null;
}

function parseId(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
}

function parseUsbIds(vid, pid) {
    const vendorId = parseId(vid, bootloader.USB_VENDOR_ID);
    const productId = parseId(pid, NaN);
    if (!Number.isFinite(vendorId) || !Number.isFinite(productId)) return null;
    return { vendorId, productId };
}

// Every entry point below is gated the same way `main/calibration.js` gates its writes: a locked
// Admin session blocks the action before it ever touches the bootloader module, per ../AGENTS.md's
// requirement that device detection, erase, programming, and verification each need password
// confirmation. Process Control V2 has no such gate -- it is layered on top of the ported logic here.
function guarded(stage, fn) {
    return async (...args) => {
        const blocked = guard();
        if (blocked) {
            progress(stage, 'error', blocked);
            return { ok: false, stage, reason: 'admin-locked', message: blocked };
        }
        if (!bootloader.isAvailable()) {
            const message = 'The node-hid module is not available in this build; firmware operations are disabled.';
            progress(stage, 'error', message);
            return { ok: false, stage, reason: 'hid-unavailable', message };
        }
        try {
            return await fn(...args);
        } catch (error) {
            progress(stage, 'error', error.message);
            return { ok: false, stage, reason: 'error', message: error.message };
        }
    };
}

const checkDevice = guarded('check-device', async (vid, pid) => {
    const ids = parseUsbIds(vid, pid);
    if (!ids) return { ok: false, stage: 'check-device', reason: 'missing-usb-id', message: 'Enter the bootloader\'s USB VID and PID before checking for the device.' };
    const present = bootloader.checkDeviceAvailable(ids.vendorId, ids.productId);
    return { ok: true, stage: 'check-device', present };
});

const connect = guarded('connect', async (vid, pid) => {
    const ids = parseUsbIds(vid, pid);
    if (!ids) {
        const message = 'Enter the bootloader\'s USB VID and PID (read from Windows Device Manager while the controller is in bootloader mode) before connecting.';
        progress('connect', 'error', message);
        return { ok: false, stage: 'connect', reason: 'missing-usb-id', message };
    }
    progress('connect', 'info', 'Searching for the Wind Tunnel bootloader device...');
    await bootloader.connect(ids.vendorId, ids.productId);
    const message = 'Connected to the bootloader device.';
    progress('connect', 'info', message);
    return { ok: true, stage: 'connect', message };
});

async function disconnect() {
    bootloader.disconnect();
    progress('disconnect', 'info', 'Disconnected from the bootloader device.');
    return { ok: true, stage: 'disconnect', message: 'Disconnected.' };
}

const loadHex = guarded('load-hex', async (hexPath) => {
    if (!hexPath) return { ok: false, stage: 'load-hex', reason: 'no-file', message: 'Select a .hex file.' };
    const result = bootloader.loadHexFile(hexPath);
    const message = `${result.recordCount} hex records loaded.`;
    progress('load-hex', 'info', message);
    if (path.basename(hexPath).toLowerCase() !== APPROVED_IMAGE_NAME.toLowerCase()) {
        progress('load-hex', 'warn', `Selected file is not the approved image (${APPROVED_IMAGE_NAME}).`);
    }
    return { ok: true, stage: 'load-hex', message, recordCount: result.recordCount };
});

const readInfo = guarded('read-info', async () => {
    progress('read-info', 'info', 'Reading bootloader info...');
    const info = await bootloader.readInfo();
    const message = `Bootloader firmware version ${info.majorVersion}.${info.minorVersion}`;
    progress('read-info', 'info', message);
    return { ok: true, stage: 'read-info', message, ...info };
});

const erase = guarded('erase', async () => {
    progress('erase', 'warn', 'Erasing application flash. Do not disconnect the device...');
    await bootloader.erase();
    const message = 'Flash erase acknowledged by the device.';
    progress('erase', 'info', message);
    return { ok: true, stage: 'erase', message };
});

const program = guarded('program', async () => {
    progress('program', 'info', 'Programming flash...');
    await bootloader.program((sent, total) => {
        progress('program', 'info', `Programmed ${sent}/${total} hex records`);
    });
    const message = 'Programming command sequence sent.';
    progress('program', 'info', message);
    return { ok: true, stage: 'program', message };
});

const readCrc = guarded('verify', async () => {
    progress('verify', 'info', 'Requesting device CRC...');
    const result = await bootloader.readCrc();
    const message = result.matches
        ? `Verification succeeded: device CRC 0x${result.deviceCrc.toString(16)} matches expected 0x${result.expectedCrc.toString(16)}.`
        : `Verification FAILED: device CRC 0x${result.deviceCrc.toString(16)} does not match expected 0x${result.expectedCrc.toString(16)}.`;
    progress('verify', result.matches ? 'info' : 'error', message);
    return { ok: result.matches, stage: 'verify', message, ...result };
});

const jumpToApp = guarded('run', async () => {
    progress('run', 'info', 'Commanding the device to exit bootloader and run the application...');
    await bootloader.run();
    const message = 'Run-application command sent. The device should restart into normal operation.';
    progress('run', 'info', message);
    return { ok: true, stage: 'run', message };
});

module.exports = {
    APPROVED_FIRMWARE_VERSION,
    APPROVED_IMAGE_NAME,
    checkDevice,
    connect,
    disconnect,
    loadHex,
    readInfo,
    erase,
    program,
    readCrc,
    jumpToApp
};
