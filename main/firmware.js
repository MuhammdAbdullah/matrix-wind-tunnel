const bootloader = require('./bootloader');
const admin = require('./admin');
const serial = require('./serial');
const { CMD } = require('./protocol');
const { state, publish, pushEvent } = require('./state');
const path = require('path');

// Single place to bump when a new approved firmware image ships (files are named WindTunnel V<x.y.z>.hex).
const APPROVED_FIRMWARE_VERSION = '2.0.6';
const APPROVED_IMAGE_NAME = `WindTunnel V${APPROVED_FIRMWARE_VERSION}.hex`;
// Any firmware file whose name does not start with this is rejected at load time.
const HEX_NAME_PREFIX = 'WindTunnel';

function progress(stage, level, message) {
    pushEvent('firmware:progress', { stage, level, message });
}

function guard() {
    if (!admin.isUnlocked()) return 'Admin session is locked. Unlock Admin before any firmware operation.';
    return null;
}

// USB IDs are hexadecimal, with or without a 0x prefix ("0x12BF", "12BF", "f010"), as Process Control V2
// parses them (parseInt(..., 16)). Plain Number() rejected un-prefixed hex such as "F010".
function parseId(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 0xFFFF ? value : NaN;
    const text = String(value).trim().replace(/^0x/i, '');
    return /^[0-9a-f]{1,4}$/i.test(text) ? parseInt(text, 16) : NaN;
}

const hexId = (id) => `0x${id.toString(16).toUpperCase().padStart(4, '0')}`;

// Names the VID/PID problem and, when the controller already shows up as a HID device, which PIDs exist.
function missingIdMessage(vid, pid) {
    const vendorId = parseId(vid, bootloader.USB_VENDOR_ID);
    const base = 'Enter the bootloader\'s USB VID and PID in hexadecimal (the VID is normally 0x12BF), read from Windows Device Manager while the controller is in bootloader mode.';
    if (!Number.isFinite(vendorId)) return base;
    const found = bootloader.listHidProductIds(vendorId);
    return found.length
        ? `${base} USB HID devices currently present with VID ${hexId(vendorId)}: PID ${found.map(hexId).join(', ')}.`
        : `${base} No USB HID device with VID ${hexId(vendorId)} is present right now.`;
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

// Mirrors Process Control V2's 'send-bootloader' handler ({"BL":1} over the serial link). The fan is
// stopped first so it is never left running when the controller resets, and the command is refused
// while a sweep owns the fan. No reply is expected: the controller drops the serial link and
// re-enumerates as the USB HID bootloader, which the Connect button then opens.
const triggerBootloader = guarded('trigger', async () => {
    if (state.simulation) return { ok: false, stage: 'trigger', reason: 'simulation', message: 'Simulation mode has no controller to put into bootloader mode.' };
    if (!state.connected) return { ok: false, stage: 'trigger', reason: 'not-connected', message: 'Controller is not connected.' };
    if (state.sweep.running) return { ok: false, stage: 'trigger', reason: 'sweep-running', message: 'Stop the active sweep before entering bootloader mode.' };
    progress('trigger', 'info', 'Stopping the fan and sending the bootloader trigger...');
    try {
        await serial.sendBinary(CMD.FAN_SPEED, Buffer.from([0]), { source: 'system' });
        state.fanSpeed = 0;
        publish();
    } catch (error) {
        progress('trigger', 'warn', `Could not confirm fan stop before the trigger: ${error.message}`);
    }
    await serial.sendBinary(CMD.ENTER_BOOTLOADER, Buffer.alloc(0), { source: 'system', retries: 0 });
    const message = 'Bootloader command sent -- click Connect (it waits up to 5 seconds for the device to enumerate).';
    progress('trigger', 'info', message);
    return { ok: true, stage: 'trigger', message };
});

const checkDevice = guarded('check-device', async (vid, pid) => {
    const ids = parseUsbIds(vid, pid);
    if (!ids) return { ok: false, stage: 'check-device', reason: 'missing-usb-id', message: missingIdMessage(vid, pid) };
    const present = bootloader.checkDeviceAvailable(ids.vendorId, ids.productId);
    return { ok: true, stage: 'check-device', present };
});

const connect = guarded('connect', async (vid, pid) => {
    const ids = parseUsbIds(vid, pid);
    if (!ids) {
        const message = missingIdMessage(vid, pid);
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
    // Only Wind Tunnel firmware images may be loaded; the check is on the file name, so it runs before
    // the file is even opened and a rejected file never replaces a previously loaded one. The message
    // is deliberately generic: the naming rule is a safety control and must not be disclosed to the operator.
    if (!path.basename(hexPath).toLowerCase().startsWith(HEX_NAME_PREFIX.toLowerCase())) {
        const message = 'This file was rejected: it is not an approved Wind Tunnel firmware image.';
        progress('load-hex', 'error', message);
        return { ok: false, stage: 'load-hex', reason: 'rejected', message };
    }
    const result = bootloader.loadHexFile(hexPath);
    const message = `${result.recordCount} hex records loaded.`;
    progress('load-hex', 'info', message);
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
    triggerBootloader,
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
