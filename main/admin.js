const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

let unlockedUntil = 0;

const appDataPath = () => path.join(app.getPath('userData'), 'wind-tunnel-admin.json');

const MIN_PASSWORD_LENGTH = 8;

// Every fresh install starts with the same initial Admin password so a first login does not depend on
// what the installer happened to type. Only its salted scrypt hash is kept here (never the plaintext);
// the first Change Password in Admin -> Settings replaces it with a per-PC credential file.
const DEFAULT_RECORD = { salt: 'UXSabAbHYA2ZceAtNYIfoA==', hash: 'QKi71yWCR142r1xvwD/SR+Ns01r+LLod4AbmPps0aOI=' };

// The file holds the scrypt hash + salt, wrapped with the OS keystore (Windows DPAPI via safeStorage)
// when available: { v: 2, enc: '<base64 safeStorage blob>' }. Older files are the bare { salt, hash }
// and are left as-is until the password is set/changed (older builds share this file and cannot read
// the wrapped format, so verifying must never silently upgrade it). With no file at all the initial
// default record applies; a file that cannot be read/decrypted yields { unreadable: true } so it is
// never mistaken for "no file" (which would let the default password unlock a damaged install).
function readAdminRecord() {
    let raw;
    try { raw = fs.readFileSync(appDataPath(), 'utf8'); } catch (error) {
        return error && error.code === 'ENOENT' ? { ...DEFAULT_RECORD, wrapped: false, isDefault: true } : { unreadable: true };
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.enc) {
            return { ...JSON.parse(safeStorage.decryptString(Buffer.from(parsed.enc, 'base64'))), wrapped: true };
        }
        if (parsed && parsed.salt && parsed.hash) return { salt: parsed.salt, hash: parsed.hash, wrapped: false };
    } catch (_error) { /* fall through */ }
    return { unreadable: true };
}

function saveAdminRecord(recordValue) {
    const { salt, hash } = recordValue;
    const stored = safeStorage.isEncryptionAvailable()
        ? { v: 2, enc: safeStorage.encryptString(JSON.stringify({ salt, hash })).toString('base64') }
        : { salt, hash };
    fs.mkdirSync(path.dirname(appDataPath()), { recursive: true });
    fs.writeFileSync(appDataPath(), JSON.stringify(stored), { mode: 0o600 });
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
    if (existing.unreadable) return { ok: false, unreadable: true };
    const ok = verifyPasswordHash(password, existing);
    if (ok) unlock();
    return { ok };
}

function setup(password) {
    if (readAdminRecord()) return { ok: false, message: 'Admin password is already set.' };
    if (!password || password.length < MIN_PASSWORD_LENGTH) return { ok: false, message: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
    saveAdminRecord(hashPassword(password));
    unlock();
    return { ok: true };
}

// Always re-checks the current password (an unlocked session alone is not enough to take over the
// account), and the new password is hashed with a fresh salt and stored the same encrypted way.
function changePassword(currentPassword, newPassword) {
    const existing = readAdminRecord();
    if (!existing) return { ok: false, needsSetup: true };
    if (existing.unreadable) return { ok: false, unreadable: true };
    if (!currentPassword || !verifyPasswordHash(currentPassword, existing)) return { ok: false, message: 'Current password is incorrect.' };
    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) return { ok: false, message: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
    if (newPassword === currentPassword) return { ok: false, message: 'New password must be different from the current one.' };
    saveAdminRecord(hashPassword(newPassword));
    unlock();
    return { ok: true };
}

module.exports = { status, verify, setup, changePassword, isUnlocked, unlock, lock };
