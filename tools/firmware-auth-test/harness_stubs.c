
#define FCV_COMMS_SOURCE_USB 1
#define FCV_COMMS_SOURCE_ETH 2
#define FCVsz_JASONSTRING 100
#define FCV_BUTTONLEFTXAXIS 20
MX_CHAR FCV_JASONSTRING[100]; MX_UINT8 FCV_COMMSSOURCE;
MX_UINT8 FCV_AUTHSTATE, FCV_AUTHPROCEED = 1, FCV_AUTHRENEW, FCV_ETHMACSET, FCV_ETHMAC[6], FCV_DHCPENABLE = 1, FCV_IP[4] = {192, 168, 1, 150};
MX_UINT16 FCV_AUTHTIMER, FCV_AUTHRENEWHOLD, FCV_USBIDLE = 1000, FCV_ETHPORT = 1245;
MX_UINT8 FCV_DHCPSTATUS;
MX_UINT8 FCV_066a1_TCP_IP_W5500__MY_IP[4] = {10, 0, 0, 7};
MX_UINT8 FCV_066a1_TCP_IP_W5500__MY_MAC[6] = {0, 8, 0xDC, 0, 0, 0};
MX_UINT16 TMR1 = 77, TMR7 = 99;

char wire[64][256]; int wires = 0; int connected = 1; int disconnects = 0; int fan = -1;
MX_UINT16 EE[256];
MX_UINT16 FCD_0ee91_flasheeprom2__Read(MX_UINT8 a) { return EE[a]; }
int ee_fail_addr = -1; /* tests set this to make Write to that address fail (returns 1, stores nothing) */
MX_UINT8 FCD_0ee91_flasheeprom2__Write(MX_UINT8 a, MX_UINT16 v) { if ((int)a == ee_fail_addr) return 1; EE[a] = v; return 0; }
const char *JSON;
MX_SINT16 FCD_0cc21_JSONDecoder1__FindName(MX_CHAR *n, MX_UINT16 sz, MX_UINT16 skip)
{ char k[32]; const char *p; snprintf(k, 32, "\"%s\":", n); p = strstr(JSON, k); return p ? (MX_SINT16)(p - JSON) : -1; }
MX_SINT32 FCD_0cc21_JSONDecoder1__ReadDataAsNumber(MX_UINT16 e)
{ const char *p = strchr(JSON + e + 1, ':'); return (MX_SINT32)atol(p + 1); }
MX_UINT16 FCD_05c71_WebSocket1__SendText(MX_CHAR *d, MX_UINT16 sz) { strncpy(wire[wires++], d, 255); return 1; }
MX_BOOL FCD_05c71_WebSocket1__IsConnected(void) { return connected; }
void FCD_05c71_WebSocket1__Disconnect(void) { connected = 0; disconnects++; }
void FCM_SetFanSpeed(MX_UINT8 s) { fan = s; }
char reply[256]; void FCM_APIReply(MX_CHAR *d, MX_UINT16 sz) { strcpy(reply, d); }
char mac_applied[32];
void FCD_066a1_TCP_IP_W5500__SetMACAddress(MX_UINT8 a, MX_UINT8 b, MX_UINT8 c, MX_UINT8 d, MX_UINT8 e, MX_UINT8 f)
{ snprintf(mac_applied, 32, "%02x%02x%02x%02x%02x%02x", a, b, c, d, e, f); }
char screen[4][64]; int scr = 0;
void FCD_03241_MatrixCapTouchDisplay1__DrawString(MX_UINT16 x, MX_UINT16 y, MX_CHAR *s, MX_UINT16 sz, MX_UINT8 f, MX_UINT8 a, MX_UINT8 b)
{ snprintf(screen[scr++], 64, "%d:%s", y, s); }
int dhcp_runs = 0, sockets_created = 0;
MX_UINT8 FCD_066a1_TCP_IP_W5500__DHCP_Run(MX_UINT16 t) { dhcp_runs++; return 3; }
MX_UINT8 FCD_05c71_WebSocket1__CreateServerSocket(MX_UINT16 port) { sockets_created++; return port == 1245; }
void FCM_EthReject(MX_UINT8 FCL_REASON);
