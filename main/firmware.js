const { pushEvent } = require('./state');
const serial = require('./serial');

const REFUSAL_MESSAGE = 'The Wind Tunnel bootloader\'s USB identity and command protocol are not confirmed against real hardware or documentation in this codebase. Process Control V2\'s bootloader protocol (different framing, different USB identity) must not be substituted -- that risks bricking the controller. Use the existing standalone PC loader for firmware updates until the bootloader protocol is confirmed.';

async function handleAction({ action }) {
    pushEvent('firmware:progress', { stage: action, level: 'info', message: `Requested ${action}...` });

    if (action === 'detect') {
        const ports = await serial.listPorts();
        pushEvent('firmware:progress', {
            stage: 'detect',
            level: 'warn',
            message: `Found ${ports.length} serial device(s). Wind Tunnel bootloader USB identity is not documented in this codebase, so a bootloader device cannot be confirmed.`
        });
        return { ok: false, stage: 'detect', reason: 'protocol-unconfirmed', message: REFUSAL_MESSAGE, portsFound: ports.length };
    }

    pushEvent('firmware:progress', { stage: action, level: 'error', message: `${action} refused: bootloader protocol not confirmed.` });
    return { ok: false, stage: action, reason: 'protocol-unconfirmed', message: REFUSAL_MESSAGE };
}

module.exports = { handleAction };
