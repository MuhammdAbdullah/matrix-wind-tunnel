const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

let unlockedUntil = 0;

const appDataPath = () => path.join(app.getPath('userData'), 'wind-tunnel-admin.json');

function readAdminRecord() {
    try { return JSON.parse(fs.readFileSync(appDataPath(), 'utf8')); } catch (_error) { return null; }
}

function saveAdminRecord(recordValue) {
    fs.mkdirSync(path.dirname(appDataPath()), { recursive: true });
    fs.writeFileSync(appDataPath(), JSON.stringify(recordValue), { mode: 0o600 });
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
    return { salt: salt.toString('base64'), hash: crypto.scryptSync(password, salt, 32).toString('base64') };
}

function verifyPasswordHash(password, recordValue) {
    const actual = crypto.scryptSync(password, Buffer.from(recordValue.salt, 'base64'), 32);
    return crypto.timingSafeEqual(actual, Buffer.from(recordValue.hash, 'base64'));
}

function isUnlocked() {
    return Date.now() < unlockedUntil;
}

function unlock() {
    unlockedUntil = Date.now() + SESSION_TIMEOUT_MS;
}

function lock() {
    unlockedUntil = 0;
}

function status() {
    return { configured: Boolean(readAdminRecord()), unlocked: isUnlocked(), secureStorage: safeStorage.isEncryptionAvailable() };
}

function verify(password) {
    const existing = readAdminRecord();
    if (!existing) return { ok: false, needsSetup: true };
    const ok = verifyPasswordHash(password, existing);
    if (ok) unlock();
    return { ok };
}

function setup(password) {
    if (!password || password.length < 8) return { ok: false, message: 'Use at least 8 characters.' };
    saveAdminRecord(hashPassword(password));
    unlock();
    return { ok: true };
}

module.exports = { status, verify, setup, isUnlocked, unlock, lock };
