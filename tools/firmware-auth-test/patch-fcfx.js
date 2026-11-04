'use strict';
// Applies the Ethernet access-control (Hi/Hey, COM/OK handshake) / network-identity edits to WindTunnel V2.0.7.fcfx.
// Every edit asserts its anchor occurs exactly once; nothing is written unless all edits apply.
const fs = require('fs');

const FILE = process.argv[2];
let src = fs.readFileSync(FILE, 'utf8');
if (src.includes('name=\'AuthGate\'')) { console.error('Already patched'); process.exit(1); }

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const T = (n) => '\t'.repeat(n);

function replaceOnce(anchor, replacement, label) {
    const first = src.indexOf(anchor);
    if (first < 0) throw new Error(`Anchor not found: ${label}`);
    if (src.indexOf(anchor, first + 1) >= 0) throw new Error(`Anchor not unique: ${label}`);
    src = src.slice(0, first) + replacement + src.slice(first + anchor.length);
}

// ---------------------------------------------------------------- 1. helper C in the supplement head
const HELPERS = `
/* ---- Ethernet access control + network identity helpers (see Matrix Wind Tunnel App/docs/ethernet-access-control.md) ---- */
enum { WT_USB_LIVE_LOOPS = 120, WT_AUTH_TIMEOUT_LOOPS = 100, WT_RENEW_HOLD_LOOPS = 600 };

static MX_UINT16 wt_putStr(MX_CHAR *b, MX_UINT16 i, const MX_CHAR *s)
{
  while (*s) { b[i] = *s; i++; s++; }
  b[i] = 0;
  return i;
}

static MX_UINT16 wt_putUInt(MX_CHAR *b, MX_UINT16 i, MX_UINT32 v)
{
  MX_CHAR t[11];
  MX_UINT8 n = 0;
  if (v == 0) { t[n] = '0'; n++; }
  while (v > 0) { t[n] = (MX_CHAR)('0' + (v % 10)); n++; v = v / 10; }
  while (n > 0) { n--; b[i] = t[n]; i++; }
  b[i] = 0;
  return i;
}

static MX_UINT16 wt_putIp(MX_CHAR *b, MX_UINT16 i, const MX_UINT8 *ip)
{
  MX_UINT8 k;
  for (k = 0; k < 4; k++)
  {
    i = wt_putUInt(b, i, ip[k]);
    if (k < 3) { b[i] = '.'; i++; }
  }
  b[i] = 0;
  return i;
}

static MX_CHAR wt_hexDigit(MX_UINT8 v)
{
  v = v & 15;
  if (v < 10) { return (MX_CHAR)('0' + v); }
  return (MX_CHAR)('A' + (v - 10));
}

static MX_UINT16 wt_putMac(MX_CHAR *b, MX_UINT16 i, const MX_UINT8 *m, MX_UINT8 colons)
{
  MX_UINT8 k;
  for (k = 0; k < 6; k++)
  {
    b[i] = wt_hexDigit(m[k] >> 4); i++;
    b[i] = wt_hexDigit(m[k]); i++;
    if (colons && k < 5) { b[i] = ':'; i++; }
  }
  b[i] = 0;
  return i;
}
`;
replaceOnce('MX_Union_32 convert;\' body=', `MX_Union_32 convert;\n${esc(HELPERS).replace(/&apos;/g, '&apos;')}' body=`, 'supplement head');

// ---------------------------------------------------------------- 2. global variables
const v = (name, type, init, desc, arraySize) =>
    `${T(4)}<variable public='0' >\n${T(5)}<def class_type='variable' name='${name}' type='${type}' description='${esc(desc)}' isconst='0' isHidden='0' isinit='${arraySize ? 0 : 1}' usrinit='${arraySize ? '&quot;&quot;' : init}' setinit='${arraySize ? '' : init}'${arraySize ? ' >' : ' />'}\n` +
    (arraySize ? `${T(6)}<array size='${arraySize}' />\n${T(5)}</def>\n` : '') + `${T(4)}</variable>\n`;
const NEW_VARS =
    v('AuthState', 'u8', 0, '0 no client, 1 waiting for Hi, 2 sent Hey and waiting for COM, 3 verified') +
    v('AuthTimer', 'u16', 0, 'Main loops since the Ethernet client connected, while unverified') +
    v('AuthProceed', 'u8', 1, 'Set by AuthGate: 0 = stop processing this JSON message') +
    v('AuthRenew', 'u8', 0, '1 = a failed Ethernet client asked for the network address to be renewed') +
    v('AuthRenewHold', 'u16', 0, 'Main loops left before the address may be renewed again') +
    v('UsbIdle', 'u16', 1000, 'Main loops since the last USB byte. USB is live below 120') +
    v('EthMacSet', 'u8', 0, '1 when a MAC address is stored in EEPROM 46-51') +
    v('EthMac', 'u8', '', 'Stored MAC address', 6);
const varAnchor = `${T(4)}<variable public='0' >\n${T(5)}<def class_type='variable' name='EthPort' type='u16'`;
replaceOnce(varAnchor, NEW_VARS + varAnchor, 'variables');

// ---------------------------------------------------------------- 3. new macros
const native = (title, code, depth) => `${T(depth)}<command class_type='native' title='${esc(title)}' ccode='${esc(code)}' language='C' />\n`;
const macro = (name, desc, params, title, code) =>
    `${T(4)}<macro >\n${T(5)}<flowline name='${name}' description='${esc(desc)}' statediag='0' >\n` +
    `${T(6)}<return name='Return' type='v0' description='' isconst='0' isHidden='0' isinit='0' usrinit='' setinit='' />\n` +
    params.map((p) => `${T(6)}<param name='${p.name}' type='${p.type}' description='${esc(p.desc || '')}' isconst='0' isHidden='0' isinit='0' usrinit='0' setinit='' />\n`).join('') +
    native(title, code, 6) + `${T(5)}</flowline>\n${T(4)}</macro>\n`;

const MACROS = [
    macro('LoadMAC', 'Reads the stored MAC address from EEPROM (words 46-51)', [], 'Load MAC', `  {
    MX_UINT16 w;
    MX_UINT8 q;
    MX_UINT8 macOk = 1;
    MX_UINT8 macNz = 0;

    FCV_ETHMACSET = 0;
    w = FCD_0ee91_flasheeprom2__Read(46);
    if (w != 0xFFFF)
    {
      for (q = 0; q < 6; q++)
      {
        w = FCD_0ee91_flasheeprom2__Read(46 + q);
        if (w > 255) { macOk = 0; }
        FCV_ETHMAC[q] = (MX_UINT8)(w & 0xFF);
        if (FCV_ETHMAC[q] != 0) { macNz = 1; }
      }
      if (macOk && macNz && ((FCV_ETHMAC[0] & 1) == 0)) { FCV_ETHMACSET = 1; }
    }
  }`),

    macro('ApplyMAC', 'Writes the stored MAC address to the W5500. Does nothing when no MAC is stored (the component default 00:08:DC:00:00:00 stays)', [], 'Apply stored MAC', `  if (FCV_ETHMACSET)
  {
    FCD_066a1_TCP_IP_W5500__SetMACAddress(FCV_ETHMAC[0], FCV_ETHMAC[1], FCV_ETHMAC[2], FCV_ETHMAC[3], FCV_ETHMAC[4], FCV_ETHMAC[5]);
  }`),

    macro('EthReject', 'Drops the Ethernet client with {"auth":Reason}. 0 = failed the Hi/COM check, 2 = USB in control, 4 = timed out. Anything but 2 also asks AuthSession to renew the network address', [{ name: 'Reason', type: 'u8', desc: 'Reason code' }], 'Reject Ethernet client', `  {
    MX_CHAR b[16];
    MX_UINT16 i;

    i = wt_putStr(b, 0, "{\\"auth\\":");
    i = wt_putUInt(b, i, FCL_REASON);
    i = wt_putStr(b, i, "}");
    if (FCD_05c71_WebSocket1__IsConnected())
    {
      FCD_05c71_WebSocket1__SendText(b, 16);
      FCD_05c71_WebSocket1__Disconnect();
    }
    FCV_AUTHSTATE = 0;
    if (FCL_REASON != 2) { FCV_AUTHRENEW = 1; }
  }`),

    macro('EthChangeAddress', 'Runs the DHCP request again after a client failed the Hi/COM check, so the controller may move to a new IP address (the router decides). Does nothing with a fixed IP. Blocks for up to 5 s, like the Network settings command does', [], 'Renew network address', `  if (FCV_DHCPENABLE)
  {
    FCV_DHCPSTATUS = FCD_066a1_TCP_IP_W5500__DHCP_Run(5000);
    FCD_05c71_WebSocket1__CreateServerSocket(FCV_ETHPORT);
  }`),

    macro('EthClientEvent', 'Ethernet client events from CheckSocketActivity: 1 = new client, 3 = client gone', [{ name: 'Ev', type: 'u8', desc: '1 new client, 3 client disconnected' }], 'Ethernet client event', `  if (FCL_EV == 1)
  {
    if (FCV_USBIDLE < WT_USB_LIVE_LOOPS)
    {
      FCM_EthReject(2);
    }
    else
    {
      FCV_AUTHSTATE = 1;
      FCV_AUTHTIMER = 0;
    }
  }
  else if (FCL_EV == 3)
  {
    if (FCV_AUTHSTATE == 3)
    {
      FCM_SetFanSpeed(0);
    }
    FCV_AUTHSTATE = 0;
  }`),

    macro('AuthSession', 'Once per main loop: USB takes priority over Ethernet, an unverified Ethernet client is dropped after a timeout, and a requested address renewal runs once the client is gone', [], 'Ethernet session housekeeping', `  if (FCV_USBIDLE < 60000) { FCV_USBIDLE++; }
  if (FCV_AUTHRENEWHOLD > 0) { FCV_AUTHRENEWHOLD--; }

  if (FCD_05c71_WebSocket1__IsConnected())
  {
    if (FCV_USBIDLE < WT_USB_LIVE_LOOPS)
    {
      FCM_EthReject(2);
    }
    else if (FCV_AUTHSTATE == 1 || FCV_AUTHSTATE == 2)
    {
      FCV_AUTHTIMER++;
      if (FCV_AUTHTIMER > WT_AUTH_TIMEOUT_LOOPS)
      {
        FCM_EthReject(4);
      }
    }
    else if (FCV_AUTHSTATE == 0)
    {
      FCM_EthReject(0);
    }
  }
  else
  {
    FCV_AUTHSTATE = 0;
    if (FCV_AUTHRENEW)
    {
      FCV_AUTHRENEW = 0;
      if (FCV_AUTHRENEWHOLD == 0 && FCV_USBIDLE >= WT_USB_LIVE_LOOPS)
      {
        FCV_AUTHRENEWHOLD = WT_RENEW_HOLD_LOOPS;
        FCM_EthChangeAddress();
      }
    }
  }`),

    macro('AuthGate', 'Called by ParseJSON before any command runs. An Ethernet client must send {"hi":1}, get {"hey":1}, send {"com":1} and get {"ok":1} before any command is accepted; anything else drops it. Sets AuthProceed to 0 to stop processing the message', [], 'Ethernet access control', `  FCV_AUTHPROCEED = 1;

  if (FCV_COMMSSOURCE == FCV_COMMS_SOURCE_ETH && FCV_AUTHSTATE != 3)
  {
    MX_UINT8 ok = 0;
    MX_CHAR b[16];

    FCV_AUTHPROCEED = 0;
    if (FCV_USBIDLE < WT_USB_LIVE_LOOPS)
    {
      FCM_EthReject(2);
    }
    else
    {
      if (FCV_AUTHSTATE == 1 && FCD_0cc21_JSONDecoder1__FindName("hi", 3, 0) > -1)
      {
        FCV_AUTHSTATE = 2;
        wt_putStr(b, 0, "{\\"hey\\":1}");
        FCD_05c71_WebSocket1__SendText(b, 16);
        ok = 1;
      }
      else if (FCV_AUTHSTATE == 2 && FCD_0cc21_JSONDecoder1__FindName("com", 4, 0) > -1)
      {
        FCV_AUTHSTATE = 3;
        wt_putStr(b, 0, "{\\"ok\\":1}");
        FCD_05c71_WebSocket1__SendText(b, 16);
        FCM_SetFanSpeed(0);
        ok = 1;
      }
      if (ok == 0)
      {
        FCM_EthReject(0);
      }
    }
  }`),

    macro('NetApiExtra', 'JSON commands netinfo, macinfo and mac0-mac5', [], 'Network info and MAC commands', `  {
    MX_SINT16 j;
    MX_UINT16 n;
    MX_UINT8 q;

    j = FCD_0cc21_JSONDecoder1__FindName("netinfo", 8, 0);
    if (j > -1)
    {
      n = wt_putStr(FCV_JASONSTRING, 0, "{\\"ip\\":\\"");
      n = wt_putIp(FCV_JASONSTRING, n, FCV_066a1_TCP_IP_W5500__MY_IP);
      n = wt_putStr(FCV_JASONSTRING, n, "\\",\\"port\\":");
      n = wt_putUInt(FCV_JASONSTRING, n, FCV_ETHPORT);
      n = wt_putStr(FCV_JASONSTRING, n, ",\\"dhcp\\":");
      n = wt_putUInt(FCV_JASONSTRING, n, FCV_DHCPENABLE ? 1 : 0);
      n = wt_putStr(FCV_JASONSTRING, n, "}");
      FCM_APIReply(FCV_JASONSTRING, FCVsz_JASONSTRING);
    }

    j = FCD_0cc21_JSONDecoder1__FindName("macinfo", 8, 0);
    if (j > -1)
    {
      n = wt_putStr(FCV_JASONSTRING, 0, "{\\"mac\\":\\"");
      n = wt_putMac(FCV_JASONSTRING, n, FCV_066a1_TCP_IP_W5500__MY_MAC, 1);
      n = wt_putStr(FCV_JASONSTRING, n, "\\",\\"sip\\":\\"");
      n = wt_putIp(FCV_JASONSTRING, n, FCV_IP);
      n = wt_putStr(FCV_JASONSTRING, n, "\\"}");
      FCM_APIReply(FCV_JASONSTRING, FCVsz_JASONSTRING);
    }

    j = FCD_0cc21_JSONDecoder1__FindName("mac0", 5, 0);
    if (j > -1)
    {
      MX_SINT16 jm[6];
      MX_SINT32 mv[6];
      MX_UINT8 good = 1;
      MX_UINT8 nz = 0;

      jm[0] = j;
      jm[1] = FCD_0cc21_JSONDecoder1__FindName("mac1", 5, 0);
      jm[2] = FCD_0cc21_JSONDecoder1__FindName("mac2", 5, 0);
      jm[3] = FCD_0cc21_JSONDecoder1__FindName("mac3", 5, 0);
      jm[4] = FCD_0cc21_JSONDecoder1__FindName("mac4", 5, 0);
      jm[5] = FCD_0cc21_JSONDecoder1__FindName("mac5", 5, 0);
      for (q = 0; q < 6; q++)
      {
        if (jm[q] < 0) { good = 0; }
      }
      if (good)
      {
        for (q = 0; q < 6; q++)
        {
          mv[q] = FCD_0cc21_JSONDecoder1__ReadDataAsNumber(jm[q]);
          if (mv[q] < 0 || mv[q] > 255) { good = 0; }
          if (mv[q] != 0) { nz = 1; }
        }
      }
      if (good && nz && ((mv[0] & 1) == 0))
      {
        for (q = 0; q < 6; q++)
        {
          FCD_0ee91_flasheeprom2__Write(46 + q, (MX_UINT16)mv[q]);
          FCV_ETHMAC[q] = (MX_UINT8)mv[q];
        }
        FCV_ETHMACSET = 1;
      }
    }
  }`),
].join('');

replaceOnce(`${T(4)}<macro >\n${T(5)}<flowline name='SyncTouchStatus'`, MACROS + `${T(4)}<macro >\n${T(5)}<flowline name='SyncTouchStatus'`, 'macro insertion point');

// ---------------------------------------------------------------- 4. APIProcess: USB activity + client events
replaceOnce(
    `${T(10)}<command class_type='calculation' title='Command from USB' >\n${T(11)}<exp exp='CommsSource = COMMS_SOURCE_USB' />\n`,
    `${T(10)}<command class_type='calculation' title='Command from USB' >\n${T(11)}<exp exp='CommsSource = COMMS_SOURCE_USB' />\n${T(11)}<exp exp='UsbIdle = 0' />\n`,
    'APIProcess USB activity');

replaceOnce(
    `${T(10)}<command class_type='decision' title='Decision' exp='EthClientConnected == 3' swap='0' >
${T(11)}<flowline >
${T(12)}<command class_type='call' title='User Macro' macro='SetFanSpeed' >
${T(13)}<argument exp='0' />
${T(12)}</command>
`,
    `${T(10)}<command class_type='decision' title='Decision' exp='EthClientConnected == 3' swap='0' >
${T(11)}<flowline >
${T(12)}<command class_type='call' title='Client gone' macro='EthClientEvent' >
${T(13)}<argument exp='3' />
${T(12)}</command>
`,
    'APIProcess client gone');

replaceOnce(
    `${T(12)}<command class_type='decision' title='Decision' exp='EthClientConnected == 1' swap='0' >
${T(13)}<flowline >
${T(14)}<command class_type='call' title='User Macro' macro='SetFanSpeed' >
${T(15)}<argument exp='0' />
${T(14)}</command>
`,
    `${T(12)}<command class_type='decision' title='Decision' exp='EthClientConnected == 1' swap='0' >
${T(13)}<flowline >
${T(14)}<command class_type='call' title='New client' macro='EthClientEvent' >
${T(15)}<argument exp='1' />
${T(14)}</command>
`,
    'APIProcess new client');

// ---------------------------------------------------------------- 5. ParseJSON: gate + new commands
replaceOnce(
    `${T(6)}<command class_type='call' title='Version of Firmware' component='JSONDecoder1' macro='FindName' >`,
    `${T(6)}<command class_type='call' title='Ethernet access control' macro='AuthGate' />\n` +
    native('Unverified Ethernet client: stop here', '  if (FCV_AUTHPROCEED == 0)\n  {\n    return;\n  }', 6) +
    `${T(6)}<command class_type='call' title='Network info, MAC and key commands' macro='NetApiExtra' />\n` +
    `${T(6)}<command class_type='call' title='Version of Firmware' component='JSONDecoder1' macro='FindName' >`,
    'ParseJSON gate');

// ---------------------------------------------------------------- 6. dhcp block applies the stored MAC first
replaceOnce(
    `${T(8)}<command class_type='call' title='Write DHCP Flag' hiddenFromFold='1' component='flasheeprom2' macro='Write' >`,
    `${T(8)}<command class_type='call' title='Apply stored MAC' hiddenFromFold='1' macro='ApplyMAC' />\n${T(8)}<command class_type='call' title='Write DHCP Flag' hiddenFromFold='1' component='flasheeprom2' macro='Write' >`,
    'dhcp block ApplyMAC');

// ---------------------------------------------------------------- 7. CommsStartup: load config, apply MAC before DHCP
replaceOnce(
    `${T(6)}<command class_type='call' title='Startup Ethernet IC' component='TCP_IP_W5500' macro='Initialise' >\n${T(7)}<return exp='CommsEthActive' />\n${T(6)}</command>\n`,
    `${T(6)}<command class_type='call' title='Load MAC from EEPROM' macro='LoadMAC' />\n` +
    `${T(6)}<command class_type='call' title='Startup Ethernet IC' component='TCP_IP_W5500' macro='Initialise' >\n${T(7)}<return exp='CommsEthActive' />\n${T(6)}</command>\n`,
    'CommsStartup load');
replaceOnce(
    `${T(6)}<command class_type='decision' title='Decision' exp='CommsEthActive' swap='0' >\n${T(7)}<flowline >\n${T(8)}<command class_type='decision' title='DHCP Enabled?' exp='DHCPEnable' swap='0' >`,
    `${T(6)}<command class_type='decision' title='Decision' exp='CommsEthActive' swap='0' >\n${T(7)}<flowline >\n${T(8)}<command class_type='call' title='Apply stored MAC before DHCP' macro='ApplyMAC' />\n${T(8)}<command class_type='decision' title='DHCP Enabled?' exp='DHCPEnable' swap='0' >`,
    'CommsStartup apply');

// ---------------------------------------------------------------- 8. main loop housekeeping
replaceOnce(
    `${T(8)}<command class_type='call' title='Process Incoming data' macro='APIProcess' />\n`,
    `${T(8)}<command class_type='call' title='Process Incoming data' macro='APIProcess' />\n${T(8)}<command class_type='call' title='USB priority and Ethernet verification timeout' macro='AuthSession' />\n`,
    'main loop');

// ---------------------------------------------------------------- 9. touchscreen settings page: port and MAC
replaceOnce(
    `${T(8)}<command class_type='calculation' title='Calculation' disable='1' >\n${T(9)}<exp exp='.IPStr = &quot;DHCP : &quot; + ToString$(DHCPStatus)' />`,
    native('Show port and MAC under the IP', `  {
    MX_CHAR b[24];
    MX_UINT16 i;

    i = wt_putStr(b, 0, "Port : ");
    i = wt_putUInt(b, i, FCV_ETHPORT);
    FCD_03241_MatrixCapTouchDisplay1__DrawString(FCV_BUTTONLEFTXAXIS, 220, b, 24, 2, 0, 0);
    i = wt_putStr(b, 0, "MAC : ");
    i = wt_putMac(b, i, FCV_066a1_TCP_IP_W5500__MY_MAC, 0);
    FCD_03241_MatrixCapTouchDisplay1__DrawString(FCV_BUTTONLEFTXAXIS, 250, b, 24, 2, 0, 0);
  }`, 8) +
    `${T(8)}<command class_type='calculation' title='Calculation' disable='1' >\n${T(9)}<exp exp='.IPStr = &quot;DHCP : &quot; + ToString$(DHCPStatus)' />`,
    'touchscreen');

fs.writeFileSync(FILE, src, 'utf8');
console.log('Patched OK:', FILE);
