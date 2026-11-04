'use strict';
// Ethernet socket fix for WindTunnel V2.0.7 (see README.md in this folder).
//
//   node apply.js fcfx      <WindTunnel V2.0.7.fcfx>   patches the Flowcode project (source of truth)
//   node apply.js generated <folder>                    patches the generated .c/.h in <folder>, for building a test hex with
//                                                       Flowcode's own compile/link batch files (no Flowcode IDE needed)
//
// Every edit asserts its anchor occurs exactly once; nothing is written unless all edits apply.
const fs = require('fs');
const path = require('path');

const MODE = process.argv[2];
const TARGET = process.argv[3];
if (!['fcfx', 'generated'].includes(MODE) || !TARGET) {
    console.error('usage: node apply.js fcfx <file.fcfx> | node apply.js generated <folder>');
    process.exit(2);
}

const BODY = fs.readFileSync(path.join(__dirname, 'ethpoll.c'), 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '');
const MACRO_DESC = 'Polls the Ethernet socket. Opens and listens only when the W5500 socket is really closed, and runs the WebSocket upgrade only once the client\'s request has arrived, so a freshly accepted connection is never wiped by the socket being re-created on every main loop. Also notices a client that vanished without a close frame';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const T = (n) => '\t'.repeat(n);

function load(file) {
    const raw = fs.readFileSync(file, 'utf8');
    const crlf = raw.includes('\r\n');
    return { text: raw.replace(/\r\n/g, '\n'), crlf };
}
function save(file, doc) {
    fs.writeFileSync(file, doc.crlf ? doc.text.replace(/\n/g, '\r\n') : doc.text, 'utf8');
}
function replaceOnce(doc, anchor, replacement, label) {
    const first = doc.text.indexOf(anchor);
    if (first < 0) throw new Error(`Anchor not found: ${label}`);
    if (doc.text.indexOf(anchor, first + 1) >= 0) throw new Error(`Anchor not unique: ${label}`);
    doc.text = doc.text.slice(0, first) + replacement + doc.text.slice(first + anchor.length);
}

if (MODE === 'fcfx') {
    const doc = load(TARGET);
    if (doc.text.includes("name='EthPoll'")) { console.error('Already patched'); process.exit(1); }

    const v = (name, type, init, desc) =>
        `${T(4)}<variable public='0' >\n${T(5)}<def class_type='variable' name='${name}' type='${type}' description='${esc(desc)}' isconst='0' isHidden='0' isinit='1' usrinit='${init}' setinit='${init}' />\n${T(4)}</variable>\n`;
    const vars = v('EthSeen', 'u8', 0, 'Polls since the WebSocket upgrade request arrived on the accepted connection') +
                 v('EthIdle', 'u16', 0, 'Polls an accepted connection has been silent');
    const varAnchor = `${T(4)}<variable public='0' >\n${T(5)}<def class_type='variable' name='EthPort' type='u16'`;
    replaceOnce(doc, varAnchor, vars + varAnchor, 'variables');

    const macro = `${T(4)}<macro >\n${T(5)}<flowline name='EthPoll' description='${esc(MACRO_DESC)}' statediag='0' >\n` +
        `${T(6)}<return name='Return' type='v0' description='' isconst='0' isHidden='0' isinit='0' usrinit='' setinit='' />\n` +
        `${T(6)}<command class_type='native' title='Poll Ethernet socket' ccode='${esc(BODY)}' language='C' />\n` +
        `${T(5)}</flowline>\n${T(4)}</macro>\n`;
    replaceOnce(doc, `${T(4)}<macro >\n${T(5)}<flowline name='SyncTouchStatus'`, macro + `${T(4)}<macro >\n${T(5)}<flowline name='SyncTouchStatus'`, 'macro insertion point');

    replaceOnce(doc,
        `${T(8)}<command class_type='call' title='Component Macro' component='WebSocket1' macro='CheckSocketActivity' >\n${T(9)}<return exp='EthClientConnected' />\n${T(8)}</command>\n`,
        `${T(8)}<command class_type='call' title='Poll Ethernet socket' macro='EthPoll' />\n`,
        'APIProcess call');


    // Robustness (see README): drop a dead client sooner, and do not re-run DHCP (a 5 s+ blackout) after a failed client.
    replaceOnce(doc, "<value target='PingIdle' data='100' />", "<value target='PingIdle' data='25' />", 'WebSocket PingIdle');
    if (doc.text.includes('if (FCL_REASON != 2) { FCV_AUTHRENEW = 1; }')) {
        replaceOnce(doc, 'if (FCL_REASON != 2) { FCV_AUTHRENEW = 1; }', '/* no address renewal after a failed client: it blacked the controller out for 5 s or more */', 'EthReject renew');
    }

    save(TARGET, doc);
    console.log('Patched OK:', TARGET);
} else {
    const cFile = path.join(TARGET, 'WindTunnel V2.0.7.c');
    const hFile = path.join(TARGET, 'WindTunnel V2.0.7.h');
    const c = load(cFile);
    const h = load(hFile);
    if (c.text.includes('FCM_EthPoll')) { console.error('Already patched'); process.exit(1); }

    replaceOnce(c, 'MX_GLOBAL MX_UINT8 FCV_ETHCLIENTCONNECTED = (0x0);\n',
        'MX_GLOBAL MX_UINT8 FCV_ETHCLIENTCONNECTED = (0x0);\n' +
        'MX_GLOBAL MX_UINT8 FCV_ETHSEEN = (0x0); // Polls since the WebSocket upgrade request arrived on the accepted connection\n' +
        'MX_GLOBAL MX_UINT16 FCV_ETHIDLE = (0x0); // Polls an accepted connection has been silent\n',
        'globals');

    // function: placed in front of the comment block that precedes FCM_APIProcess
    const fnIdx = c.text.indexOf('\nvoid FCM_APIProcess()');
    if (fnIdx < 0 || c.text.indexOf('\nvoid FCM_APIProcess()', fnIdx + 1) >= 0) throw new Error('FCM_APIProcess definition not found exactly once');
    const blockStart = c.text.lastIndexOf('/*=', fnIdx);
    const fn = `/*=----------------------------------------------------------------------=*\\\n   Use :${MACRO_DESC}\n\\*=----------------------------------------------------------------------=*/\n` +
        `void FCM_EthPoll()\n{\n\n  // Poll Ethernet socket\n${BODY}\n\n}\n\n`;
    c.text = c.text.slice(0, blockStart) + fn + c.text.slice(blockStart);

    replaceOnce(c, '    // Component Macro\n    FCV_ETHCLIENTCONNECTED = FCD_05c71_WebSocket1__CheckSocketActivity();\n',
        '    // User Macro\n    FCM_EthPoll();\n', 'APIProcess call');

    replaceOnce(c, '(100 > 0) && (FCV_05c71_WebSocket1__IDLECOUNT >= 100)', '(25 > 0) && (FCV_05c71_WebSocket1__IDLECOUNT >= 25)', 'WebSocket PingIdle');
    if (c.text.includes('if (FCL_REASON != 2) { FCV_AUTHRENEW = 1; }')) {
        replaceOnce(c, 'if (FCL_REASON != 2) { FCV_AUTHRENEW = 1; }', '/* no address renewal after a failed client: it blacked the controller out for 5 s or more */', 'EthReject renew');
    }

    replaceOnce(h, 'void FCM_SyncTouchStatus(MX_UINT8 FCL_SEND);\n', 'void FCM_SyncTouchStatus(MX_UINT8 FCL_SEND);\nvoid FCM_EthPoll();\n', 'prototype');

    save(cFile, c);
    save(hFile, h);
    console.log('Patched OK:', TARGET);
}
