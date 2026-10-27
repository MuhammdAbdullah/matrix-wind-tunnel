const fs = require('fs');

// The whole module, as in Process Control V2 (`const HID = require('node-hid')`): `HID.devices()` is a
// module-level function and `new HID.HID(...)` is the device class. Destructuring `{ HID }` would leave
// only the class, which has no `devices()`.
let HID;
try { HID = require('node-hid'); } catch (_error) { HID = null; }

// Confirmed from assets/bootloader-source/ (copied from Process Control V2's generic Matrix
// PIC32 bootloader tool). The application firmware's USB identity (VID 0x12BF / PID 0xF010) is
// documented in ../AGENTS.md, but the bootloader's PID is NOT confirmed anywhere in this
// codebase -- Process Control V2's own bootloader enumerates under a different PID (0x010C)
// than its running application (0x0113), and PIC32 USB bootloaders commonly do the same. Do not
// hardcode a bootloader PID here; callers must supply the VID/PID the operator reads from
// Windows Device Manager while the controller is in bootloader mode.
const USB_VENDOR_ID = 0x12BF;
const USB_REPORT_SIZE = 64;

// This module is a verbatim port of Process Control V2/main.js's bootloader protocol logic
// (persistent-connection model, CRC table/algorithm, frame escaping, Intel HEX handling, batching,
// timeouts/retries) -- see ../AGENTS.md and CLAUDE.md's "Bootloader protocol" section. Per explicit
// instruction, this port intentionally reproduces Process Control V2's behavior exactly, including
// its one known latent bug (the undersized virtual-flash CRC buffer below) -- do not "fix" it here.

const SOH = 0x01;
const EOT = 0x04;
const DLE = 0x10;

const CMD = {
    READ_BOOT_INFO: 1,
    ERASE_FLASH: 2,
    PROGRAM_FLASH: 3,
    READ_CRC: 4,
    JMP_TO_APP: 5
};

const BOOT_SECTOR_BEGIN = 0x7FC000;
// Process Control V2's calculateFlashCRCFromHexFile() sizes its virtual-flash scratch buffer at
// exactly 5 MB -- smaller than BOOT_SECTOR_BEGIN above. This is a latent buffer-overflow bug in the
// original C++ tool that Process Control V2's JS reproduces verbatim. The user has explicitly asked
// for this app to bring the bootloader over "as it is" from Process Control, bug included -- do NOT
// enlarge this buffer to "fix" it.
const FLASH_SIZE = 5 * 1024 * 1024;

// Process Control V2 pads a command's response-wait timeout by this much beyond the caller-supplied
// `delayMs` (see its sendBootloaderCommand()'s `const timeoutMs = delayMs + 3000`). Preserved here so
// per-command timing matches exactly.
const RESPONSE_TIMEOUT_PAD_MS = 3000;

// Process Control V2 batches up to 10 raw Intel-HEX records per PROGRAM_FLASH exchange.
const RECORDS_PER_COMMAND = 10;

// Process Control V2 polls up to 10 times, 500ms apart, when opening the bootloader USB HID device --
// the device may still be enumerating after a bootloader-mode trigger.
const CONNECT_POLL_RETRIES = 10;
const CONNECT_POLL_INTERVAL_MS = 500;

const CRC_TABLE = [
    0x0000, 0x1021, 0x2042, 0x3063, 0x4084, 0x50a5, 0x60c6, 0x70e7,
    0x8108, 0x9129, 0xa14a, 0xb16b, 0xc18c, 0xd1ad, 0xe1ce, 0xf1ef
];

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateCrc(bytes) {
    let crc = 0;
    for (let n = 0; n < bytes.length; n += 1) {
        const byte = bytes[n];
        let i = (crc >> 12) ^ (byte >> 4);
        crc = (CRC_TABLE[i & 0x0F] ^ (crc << 4)) & 0xFFFF;
        i = (crc >> 12) ^ byte;
        crc = (CRC_TABLE[i & 0x0F] ^ (crc << 4)) & 0xFFFF;
    }
    return crc & 0xFFFF;
}

function buildFrame(cmd, payload) {
    const body = Buffer.concat([Buffer.from([cmd]), payload]);
    const crc = calculateCrc(body);
    const framed = Buffer.concat([body, Buffer.from([crc & 0xFF, (crc >> 8) & 0xFF])]);
    const out = [SOH];
    for (const byte of framed) {
        if (byte === EOT || byte === SOH || byte === DLE) out.push(DLE);
        out.push(byte);
    }
    out.push(EOT);
    return Buffer.from(out);
}

function toHidReports(framedBytes) {
    const reports = [];
    for (let offset = 0; offset < framedBytes.length; offset += USB_REPORT_SIZE) {
        const chunk = Buffer.alloc(USB_REPORT_SIZE, 0xFF);
        framedBytes.copy(chunk, 0, offset, Math.min(offset + USB_REPORT_SIZE, framedBytes.length));
        reports.push(Buffer.concat([Buffer.from([0x00]), chunk]));
    }
    return reports;
}

function createFrameAssembler(maxLen = 512) {
    let escape = false;
    let rxData = [];
    return (byte, onFrame) => {
        if (rxData.length >= maxLen) rxData = [];
        switch (byte) {
            case SOH:
                if (escape) { rxData.push(byte); escape = false; } else { rxData = []; }
                break;
            case EOT:
                if (escape) { rxData.push(byte); escape = false; }
                else {
                    if (rxData.length > 2) {
                        const bodyLen = rxData.length - 2;
                        const crc = (rxData[bodyLen] & 0xFF) | ((rxData[bodyLen + 1] << 8) & 0xFF00);
                        if (calculateCrc(Buffer.from(rxData.slice(0, bodyLen))) === crc) {
                            onFrame(Buffer.from(rxData.slice(0, bodyLen)));
                        }
                    }
                    rxData = [];
                }
                break;
            case DLE:
                if (escape) { rxData.push(byte); escape = false; } else { escape = true; }
                break;
            default:
                rxData.push(byte);
                escape = false;
                break;
        }
    };
}

function isAvailable() {
    return Boolean(HID);
}

// ---------------------------------------------------------------------------
// Persistent connection state. Process Control V2 opens the USB HID device once
// (on "Connect") and keeps it open in module-scope state; every subsequent
// erase/program/verify/read-info/run call reuses that same open handle until the
// operator disconnects or the device jumps to the application. Mirrored here.
// ---------------------------------------------------------------------------
let device = null;
let assembler = null;
let pending = null; // { cmd, resolve, timer }
let hexRecords = []; // raw Intel-HEX record Buffers, stopping before the EOF record
let flashInfo = null; // { startAddress, progLen, crc }

function onData(data) {
    let bytes = data;
    if (bytes.length > USB_REPORT_SIZE) bytes = bytes.subarray(bytes.length - USB_REPORT_SIZE);
    for (let i = 0; i < bytes.length; i += 1) {
        assembler(bytes[i], (frame) => {
            if (!pending || frame[0] !== pending.cmd) return;
            clearTimeout(pending.timer);
            const resolve = pending.resolve;
            pending = null;
            resolve(frame.subarray(1));
        });
    }
}

function onError(_error) {
    // Device disconnection (e.g. right after JMP_TO_APP) surfaces here; this is expected and
    // matches Process Control V2 treating it as a normal post-jump disconnect, not an error to
    // surface to the operator.
}

function checkDeviceAvailable(vid, pid) {
    if (!HID) return false;
    try {
        return HID.devices().some((d) => d.vendorId === vid && d.productId === pid);
    } catch (_error) {
        return false;
    }
}

// USB HID devices currently present under a vendor ID, so the operator can see the bootloader's PID
// without opening Device Manager.
function listHidProductIds(vid) {
    if (!HID) return [];
    try {
        const pids = new Set(HID.devices().filter((d) => d.vendorId === vid).map((d) => d.productId));
        return [...pids];
    } catch (_error) {
        return [];
    }
}

function isConnected() {
    return Boolean(device);
}

async function connect(vid, pid) {
    if (!HID) throw new Error('The node-hid module is not installed in this build.');
    if (!vid || !pid) throw new Error('A USB VID and PID are required to open the bootloader device.');

    disconnect();

    let devicePath = null;
    for (let attempt = 1; attempt <= CONNECT_POLL_RETRIES; attempt += 1) {
        const matches = HID.devices().filter((d) => d.vendorId === vid && d.productId === pid);
        if (matches.length) { devicePath = matches[0].path; break; }
        if (attempt < CONNECT_POLL_RETRIES) await sleep(CONNECT_POLL_INTERVAL_MS);
    }
    if (!devicePath) {
        throw new Error(`USB bootloader device with VID 0x${vid.toString(16).toUpperCase()} / PID 0x${pid.toString(16).toUpperCase()} was not found after ${CONNECT_POLL_RETRIES} attempts. Put the controller into bootloader mode and confirm the PID in Device Manager.`);
    }

    try {
        device = new HID.HID(devicePath);
    } catch (error) {
        device = null;
        throw new Error(`Failed to open bootloader device: ${error.message}`);
    }

    assembler = createFrameAssembler();
    device.on('data', onData);
    device.on('error', onError);
    return true;
}

function disconnect() {
    if (!device) return;
    try { device.removeListener('data', onData); } catch (_error) { /* ignore */ }
    try { device.removeListener('error', onError); } catch (_error) { /* ignore */ }
    try { device.close(); } catch (_error) { /* already closed */ }
    device = null;
    pending = null;
}

function exchangeCommand(cmd, payload, { retries, delayMs, requireResponse = true }) {
    if (!device) return Promise.reject(new Error('Bootloader device is not connected. Click Connect first.'));
    const reports = toHidReports(buildFrame(cmd, payload));

    if (!requireResponse) {
        reports.forEach((report) => device.write(Array.from(report)));
        return Promise.resolve(Buffer.alloc(0));
    }

    const timeoutMs = delayMs + RESPONSE_TIMEOUT_PAD_MS;
    const attempt = () => new Promise((resolve) => {
        pending = {
            cmd,
            resolve,
            timer: setTimeout(() => { pending = null; resolve(null); }, timeoutMs)
        };
        reports.forEach((report) => device.write(Array.from(report)));
    });

    return (async () => {
        for (let count = 0; count < retries; count += 1) {
            const data = await attempt();
            if (data) return data;
        }
        throw new Error(`No response from bootloader for command ${cmd} after ${retries} attempt(s)`);
    })();
}

// Matches Process Control V2's sendBootloaderCommand(READ_BOOT_INFO, ..., 3, 200).
async function readInfo() {
    const data = await exchangeCommand(CMD.READ_BOOT_INFO, Buffer.alloc(0), { retries: 3, delayMs: 200 });
    return { majorVersion: data[0], minorVersion: data[1] };
}

// Matches Process Control V2's sendBootloaderCommand(ERASE_FLASH, ..., 3, 5000).
async function erase() {
    await exchangeCommand(CMD.ERASE_FLASH, Buffer.alloc(0), { retries: 3, delayMs: 5000 });
}

// Matches Process Control V2's JMP_TO_APP call (1 attempt, 10ms, no response expected) and its
// clearing of the device handle afterwards (the device disconnects itself once it jumps).
async function run() {
    await exchangeCommand(CMD.JMP_TO_APP, Buffer.alloc(0), { retries: 1, delayMs: 10, requireResponse: false });
    disconnect();
}

function loadHexLines(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith(':'));
    if (!lines.length) throw new Error('No valid Intel HEX records found in the selected file.');
    return lines;
}

function decodeHexAsciiLine(line) {
    const hex = line.slice(1).replace(/[^0-9a-fA-F]/g, '');
    const byteCount = Math.floor(hex.length / 2);
    const bytes = Buffer.alloc(byteCount);
    for (let i = 0; i < byteCount; i += 1) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
}

function validateHexChecksums(lines) {
    lines.forEach((line, index) => {
        const bytes = decodeHexAsciiLine(line);
        if (bytes.length < 5) throw new Error(`Hex record ${index + 1} is too short: "${line}"`);
        const sum = bytes.reduce((total, byte) => (total + byte) & 0xFF, 0);
        if (sum !== 0) throw new Error(`Checksum mismatch on hex record ${index + 1}: "${line}"`);
    });
}

// Mirrors Process Control V2's calculateFlashCRCFromHexFile(): processes ALL lines in the file
// (it never stops at the EOF record -- that record's type 0x01 just falls into the default case,
// which resets the extended-address state and continues). The 5 MB buffer and the bounded per-byte
// write below reproduce its latent overflow bug verbatim rather than guarding against it with a
// larger buffer or a throwing Buffer.copy().
function computeVerifyInfo(lines) {
    const virtualFlash = Buffer.alloc(FLASH_SIZE);
    for (let i = 0; i < virtualFlash.length; i += 1) virtualFlash[i] = ((i + 1) % 4) ? 0xFF : 0x00;

    let extSegAddress = 0;
    let extLinAddress = 0;
    let minAddress = 0xFFFFFFFF;
    let maxAddress = 0;

    lines.forEach((line) => {
        const record = decodeHexAsciiLine(line);
        if (record.length < 5) return;
        const recDataLen = record[0];
        const recType = record[3];
        const data = record.subarray(4, 4 + recDataLen);
        switch (recType) {
            case 0: {
                let address = (((record[1] << 8) & 0xFF00) | (record[2] & 0xFF)) & 0xFFFF;
                address = (address + extLinAddress + extSegAddress) >>> 0;
                if (address < BOOT_SECTOR_BEGIN) {
                    if (maxAddress < address + recDataLen) maxAddress = address + recDataLen;
                    if (minAddress > address) minAddress = address;
                    // Bounded per-byte write (deliberately not Buffer.copy, which would throw a
                    // RangeError once FLASH_SIZE < BOOT_SECTOR_BEGIN): bytes landing at or past
                    // FLASH_SIZE are silently dropped, reproducing the C/JS original's overflow
                    // bug's effect (a wrong/short CRC) instead of crashing the host on it.
                    for (let i = 0; i < data.length && (address + i) < FLASH_SIZE; i += 1) {
                        virtualFlash[address + i] = data[i];
                    }
                }
                break;
            }
            case 2:
                extSegAddress = (((data[0] << 16) & 0xFF0000) | ((data[1] << 8) & 0xFF00)) >>> 0;
                extLinAddress = 0;
                break;
            case 4:
                extLinAddress = (((data[0] << 24) & 0xFF000000) | ((data[1] << 16) & 0xFF0000)) >>> 0;
                extSegAddress = 0;
                break;
            default:
                extSegAddress = 0;
                extLinAddress = 0;
                break;
        }
    });

    if (minAddress === 0xFFFFFFFF) throw new Error('No programmable data records found below the boot sector in this hex file.');

    minAddress -= minAddress % 4;
    maxAddress += maxAddress % 4;
    const progLen = maxAddress - minAddress;
    const startAddress = Math.floor(minAddress / 2);
    const crc = calculateCrc(virtualFlash.subarray(minAddress, minAddress + progLen));
    return { startAddress, progLen, crc };
}

// Loads and parses a .hex file, populating the module-level program batch (hexRecords, stopping
// before the EOF record -- mirroring Process Control V2's parseHexFile(), which breaks out of its
// record loop as soon as it sees record type 0x01) and the verify CRC/address info (computed over
// every line in the file, per computeVerifyInfo() above).
function loadHexFile(filePath) {
    const lines = loadHexLines(filePath);
    validateHexChecksums(lines);

    const records = [];
    for (const line of lines) {
        const bytes = decodeHexAsciiLine(line);
        if (bytes.length < 5) continue;
        if (bytes[3] === 0x01) break; // End-of-file record -- stop collecting, like parseHexFile().
        records.push(bytes);
    }
    if (!records.length) throw new Error('No programmable hex records found before the end-of-file record.');

    hexRecords = records;
    flashInfo = computeVerifyInfo(lines);
    return { recordCount: hexRecords.length, flashInfo };
}

// Matches Process Control V2's bootloader-program-flash handler: batches of RECORDS_PER_COMMAND
// (10) raw hex records per PROGRAM_FLASH exchange, each exchange fire-and-forget (no response wait,
// no retry), with a 2ms pause between batches.
async function program(onProgress) {
    if (!hexRecords.length) throw new Error('No hex file loaded');
    const total = hexRecords.length;
    for (let i = 0; i < total; i += RECORDS_PER_COMMAND) {
        const batch = hexRecords.slice(i, i + RECORDS_PER_COMMAND);
        const batchBuffer = Buffer.concat(batch);
        await exchangeCommand(CMD.PROGRAM_FLASH, batchBuffer, { retries: 1, delayMs: 0, requireResponse: false });
        const sent = Math.min(i + RECORDS_PER_COMMAND, total);
        if (onProgress) onProgress(sent, total);
        if (sent < total) await sleep(2);
    }
}

// Matches Process Control V2's bootloader-read-crc handler: READ_CRC payload is
// StartAddress(4 LE) + Length(4 LE) + ExpectedCRC(2 LE), 3 retries, 2000ms.
async function readCrc() {
    if (!flashInfo) throw new Error('No hex file loaded');
    const payload = Buffer.alloc(10);
    payload.writeUInt32LE(flashInfo.startAddress, 0);
    payload.writeUInt32LE(flashInfo.progLen, 4);
    payload.writeUInt16LE(flashInfo.crc, 8);
    const data = await exchangeCommand(CMD.READ_CRC, payload, { retries: 3, delayMs: 2000 });
    const deviceCrc = (data[0] & 0xFF) | ((data[1] << 8) & 0xFF00);
    return { deviceCrc, expectedCrc: flashInfo.crc, matches: deviceCrc === flashInfo.crc };
}

module.exports = {
    USB_VENDOR_ID,
    isAvailable,
    checkDeviceAvailable,
    listHidProductIds,
    isConnected,
    connect,
    disconnect,
    readInfo,
    erase,
    program,
    run,
    readCrc,
    loadHexFile
};
