/* Host-side model of the W5500 socket 0 + the WebSocket component, taken from Firmware/WindTunnel V2.0.7.c:
 *   W5500: CreateTCPSocket (CLOSE + OPEN), RxDataAvailable (GRXPTR = Sn_RX_RD, GRXSIZE = Sn_RX_RSR), RxReadArray (GRXPTR += n),
 *          RxFlushData; Sn_RX_RD only moves when the firmware writes it and issues RECV.
 *   NetworkComms1: AcceptOpen/AcceptClose, Receive (RXCOUNT chunking, no timeout).
 *   WebSocket1: CheckSocketActivity, Prv_Handshake (reads to CRLFCRLF), Prv_ReceiveFrame (header/mask/payload, opcode 8 = close).
 * It runs the OLD main-loop call and the NEW FCM_EthPoll through the same scenarios.
 * Logic only: it does not prove timing on real hardware.  Build: gcc -Wall -o harness harness.c && ./harness */
#include <stdio.h>
#include <string.h>

typedef unsigned char MX_UINT8;
typedef unsigned short MX_UINT16;
typedef char MX_CHAR;

enum { SR_CLOSED = 0x00, SR_INIT = 0x13, SR_LISTEN = 0x14, SR_SYNRECV = 0x16, SR_ESTAB = 0x17, SR_CLOSE_WAIT = 0x1C };
enum { REG_RSR = 1, REG_RD = 2, REG_CR = 3, CR_RECV = 0x40 };
#define FCV_066a1_TCP_IP_W5500__SN_RX_RSR REG_RSR
#define FCV_066a1_TCP_IP_W5500__SN_RX_RD REG_RD
#define FCV_066a1_TCP_IP_W5500__SN_CR REG_CR
#define FCV_066a1_TCP_IP_W5500__SN_CR_RECV CR_RECV

/* ---------------------------------------------------------------- W5500 socket 0 */
static MX_UINT8 sr = SR_CLOSED;
static MX_UINT8 ring[2048];
static MX_UINT16 rx_rd, rx_wr;          /* free running 16 bit pointers, buffer index = & 0x7FF */
static MX_UINT16 FCV_066a1_TCP_IP_W5500__GRXPTR[1];
static MX_UINT16 grxsize;
static int wiped_established = 0, create_calls = 0, recv_cmds = 0;

static MX_UINT16 rsr(void) { return (MX_UINT16)(rx_wr - rx_rd); }
static MX_UINT8 FCD_066a1_TCP_IP_W5500__GetSocketStatus(MX_UINT8 ch) { (void)ch; return sr; }
static void FCD_066a1_TCP_IP_W5500__MAC_SetRegister(MX_UINT8 ch) { (void)ch; }
static MX_UINT16 FCD_066a1_TCP_IP_W5500__MAC_ReadWord(MX_UINT16 reg) { return reg == REG_RSR ? rsr() : rx_rd; }
static void FCD_066a1_TCP_IP_W5500__MAC_WriteWord(MX_UINT16 reg, MX_UINT16 v) { if (reg == REG_RD) { rx_rd = v; } }
static void FCD_066a1_TCP_IP_W5500__MAC_WriteByte(MX_UINT16 reg, MX_UINT8 v) { if (reg == REG_CR && v == CR_RECV) { recv_cmds++; } }
static MX_UINT8 FCD_066a1_TCP_IP_W5500__CreateTCPSocket(MX_UINT8 ch, MX_UINT16 port)
{
    (void)ch; (void)port;
    create_calls++;
    if (sr == SR_ESTAB) { wiped_established++; }
    sr = SR_INIT; rx_rd = rx_wr = 0;
    return 1;
}
static void FCD_066a1_TCP_IP_W5500__TCPListen(MX_UINT8 ch) { (void)ch; sr = SR_LISTEN; }
static void FCD_066a1_TCP_IP_W5500__RxFlushData(MX_UINT8 ch)
{
    (void)ch;
    if (rsr()) { rx_rd = (MX_UINT16)(rx_rd + rsr()); recv_cmds++; }
}
static MX_UINT8 FCD_066a1_TCP_IP_W5500__RxDataAvailable(MX_UINT8 ch)
{
    (void)ch;
    if (!rsr()) { return 0; }
    FCV_066a1_TCP_IP_W5500__GRXPTR[0] = rx_rd; /* TCP branch: no header, offset = Sn_RX_RD */
    grxsize = rsr();
    return grxsize >= 255 ? 255 : (MX_UINT8)grxsize;
}
static void FCD_066a1_TCP_IP_W5500__RxReadArray(MX_UINT8 ch, MX_UINT8 *d, MX_UINT16 sz, MX_UINT16 n)
{
    MX_UINT16 i;
    (void)ch; (void)sz;
    for (i = 0; i < n; i++) { d[i] = ring[(FCV_066a1_TCP_IP_W5500__GRXPTR[0] + i) & 0x7FF]; }
    FCV_066a1_TCP_IP_W5500__GRXPTR[0] = (MX_UINT16)(FCV_066a1_TCP_IP_W5500__GRXPTR[0] + n);
}

/* ---------------------------------------------------------------- NetworkComms1 */
static MX_UINT8 FCV_05061_NetworkComms1__CLOSED = 1;
static MX_UINT16 FCV_05061_NetworkComms1__RXCOUNT = 0;
static MX_UINT8 FCV_05061_NetworkComms1__TXDATASTART = 0;
static MX_UINT16 FCV_05061_NetworkComms1__PORT = 1245;

static MX_UINT16 nc_receive(MX_UINT8 *d, MX_UINT16 count)
{
    MX_UINT8 avail;
    MX_UINT16 ret = 0;
    avail = FCV_05061_NetworkComms1__RXCOUNT == 0 ? FCD_066a1_TCP_IP_W5500__RxDataAvailable(0) : 1;
    if (avail)
    {
        ret = FCV_05061_NetworkComms1__RXCOUNT == 0 ? grxsize : FCV_05061_NetworkComms1__RXCOUNT;
        if (ret > count) { FCV_05061_NetworkComms1__RXCOUNT = ret - count; ret = count; }
        else { FCV_05061_NetworkComms1__RXCOUNT = 0; }
        FCD_066a1_TCP_IP_W5500__RxReadArray(0, d, 20, ret); /* flush is "Disabled code" in the real Receive */
    }
    return ret;
}

/* ---------------------------------------------------------------- WebSocket1 */
static MX_UINT8 ws_connected = 0;
static MX_UINT8 rxdata[128];
static MX_UINT16 rxcount, rxopcode;
static int handshakes_ok = 0, handshakes_400 = 0, closelinks = 0, frames = 0;

static MX_UINT8 FCD_05c71_WebSocket1__IsConnected(void) { return ws_connected; }
static void FCD_05c71_WebSocket1__Prv_CloseLink(void) { ws_connected = 0; FCV_05061_NetworkComms1__CLOSED = 1; sr = SR_CLOSED; closelinks++; }

static MX_UINT8 ws_handshake(void)
{
    MX_UINT8 c;
    MX_UINT16 n, tries = 0, eoh = 0, got = 0;
    MX_UINT8 first[3] = {0, 0, 0};
    while (eoh < 4 && tries < 25)
    {
        n = nc_receive(&c, 1);
        if (n > 0)
        {
            tries = 0;
            if (got < 3) { first[got] = c; }
            got++;
            if ((eoh & 1) == 0) { eoh = (c == 13) ? eoh + 1 : 0; }
            else { eoh = (c == 10) ? eoh + 1 : (c == 13 ? 1 : 0); }
        }
        else { tries++; }
    }
    if (eoh == 4 && first[0] == 'G') { ws_connected = 1; handshakes_ok++; return 1; }
    handshakes_400++;
    FCV_05061_NetworkComms1__CLOSED = 1; /* AcceptClose after "400 Bad Request" */
    return 0;
}

static MX_UINT8 ws_receive_frame(void)
{
    MX_UINT8 hdr[2], mask[4] = {0, 0, 0, 0}, tmp[20];
    MX_UINT16 n, len, pos, i;
    rxcount = 0;
    n = nc_receive(hdr, 2);
    if (n == 0) { return 0; }
    if (n == 1) { nc_receive(tmp, 1); hdr[1] = tmp[0]; }
    rxopcode = hdr[0] & 0x0F;
    len = hdr[1] & 0x7F;
    if (hdr[1] & 0x80) { nc_receive(mask, 4); }
    for (pos = 0; pos < len;)
    {
        MX_UINT16 chunk = len - pos > 20 ? 20 : len - pos;
        n = nc_receive(tmp, chunk);
        if (n == 0) { break; }
        for (i = 0; i < n; i++) { if (rxcount < 127) { rxdata[rxcount++] = tmp[i] ^ mask[(pos + i) & 3]; } }
        pos += n;
    }
    rxdata[rxcount] = 0;
    if (rxopcode == 8) { ws_connected = 0; FCV_05061_NetworkComms1__CLOSED = 1; sr = SR_CLOSED; closelinks++; return 3; }
    frames++;
    return 2;
}

static MX_UINT8 FCD_05c71_WebSocket1__CheckSocketActivity(void)
{
    if (ws_connected) { return ws_receive_frame(); }
    if (FCV_05061_NetworkComms1__CLOSED) /* AcceptOpen */
    {
        FCD_066a1_TCP_IP_W5500__CreateTCPSocket(0, FCV_05061_NetworkComms1__PORT);
        FCD_066a1_TCP_IP_W5500__TCPListen(0);
        FCD_066a1_TCP_IP_W5500__RxFlushData(0);
        FCV_05061_NetworkComms1__CLOSED = 0;
    }
    return ws_handshake();
}

/* ---------------------------------------------------------------- USB stack state */
volatile MX_UINT16 USBDeviceState = 0;  /* Microchip stack: 0x20 = CONFIGURED_STATE */
static int FCV_COMMSUSBACTIVE = 1;

/* ---------------------------------------------------------------- shared command queue (CircularBuffer1) */
static int cmdq[64], cmdq_n = 0;       /* ids of whole messages waiting to be parsed, oldest first */
static int FCV_COMMSSTATE = 0;
static int flushes = 0;
static void FCD_01212_CircularBuffer1__FlushBuffer(void) { cmdq_n = 0; flushes++; }
static void queue_put(int id) { cmdq[cmdq_n++] = id; }
static int queue_parse(void) { int id, i; if (!cmdq_n) { return -1; } id = cmdq[0]; for (i = 1; i < cmdq_n; i++) { cmdq[i - 1] = cmdq[i]; } cmdq_n--; return id; }

/* ---------------------------------------------------------------- the code under test */
static MX_UINT8 FCV_ETHCLIENTCONNECTED = 0;
static MX_UINT8 FCV_ETHSEEN = 0;
static MX_UINT16 FCV_ETHIDLE = 0;

static void FCM_EthPoll(void)
{
#include "ethpoll.c"
}

/* ---------------------------------------------------------------- scenarios */
static void reset(void)
{
    sr = SR_CLOSED; rx_rd = rx_wr = 0; wiped_established = 0; create_calls = 0; recv_cmds = 0;
    FCV_05061_NetworkComms1__CLOSED = 1; FCV_05061_NetworkComms1__RXCOUNT = 0; FCV_05061_NetworkComms1__TXDATASTART = 0;
    ws_connected = 0; handshakes_ok = 0; handshakes_400 = 0; closelinks = 0; frames = 0; rxcount = 0; rxopcode = 0;
    cmdq_n = 0; flushes = 0; FCV_COMMSSTATE = 1;
    FCV_ETHCLIENTCONNECTED = 0; FCV_ETHSEEN = 0; FCV_ETHIDLE = 0; FCV_066a1_TCP_IP_W5500__GRXPTR[0] = 0;
}
static void old_loop(void) { FCV_ETHCLIENTCONNECTED = FCD_05c71_WebSocket1__CheckSocketActivity(); }
static void new_loop(void) { FCM_EthPoll(); }
static int fails = 0;
#define CHECK(cond, msg) do { if (cond) { printf("  ok    %s\n", msg); } else { printf("  FAIL  %s\n", msg); fails++; } } while (0)

static void push(const MX_UINT8 *d, MX_UINT16 n) { MX_UINT16 i; for (i = 0; i < n; i++) { ring[rx_wr & 0x7FF] = d[i]; rx_wr++; } }
static const char REQUEST[] =
    "GET / HTTP/1.1\r\nHost: 192.168.1.150:1245\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";
static void client_connects_and_sends_request(void) { if (sr == SR_LISTEN) { sr = SR_ESTAB; push((const MX_UINT8 *)REQUEST, (MX_UINT16)strlen(REQUEST)); } }
static void client_sends_frame(const char *text) /* masked text frame, as every browser/ws client sends */
{
    MX_UINT8 f[130]; MX_UINT16 n = (MX_UINT16)strlen(text), i; const MX_UINT8 m[4] = {0x37, 0xFA, 0x21, 0x3D};
    f[0] = 0x81; f[1] = (MX_UINT8)(0x80 | n); memcpy(f + 2, m, 4);
    for (i = 0; i < n; i++) { f[6 + i] = (MX_UINT8)text[i] ^ m[i & 3]; }
    push(f, (MX_UINT16)(6 + n));
}

int main(void)
{
    int i;

    printf("OLD loop (CheckSocketActivity every pass):\n");
    reset();
    for (i = 0; i < 3; i++) { old_loop(); }
    client_connects_and_sends_request();
    for (i = 0; i < 3; i++) { old_loop(); }
    CHECK(handshakes_ok == 0, "client is never handshaken");
    CHECK(wiped_established >= 1, "the established connection is destroyed by the socket being re-created");

    printf("NEW loop, connection and handshake:\n");
    reset();
    for (i = 0; i < 5; i++) { new_loop(); }
    CHECK(sr == SR_LISTEN && create_calls == 1, "closed socket is opened once and left listening");
    {
        size_t half = strlen(REQUEST) / 2;
        sr = SR_ESTAB; push((const MX_UINT8 *)REQUEST, (MX_UINT16)half);
        for (i = 0; i < 5; i++) { new_loop(); }
        CHECK(handshakes_ok == 0 && handshakes_400 == 0 && wiped_established == 0, "half a request: the handshake is not started");
        push((const MX_UINT8 *)REQUEST + half, (MX_UINT16)(strlen(REQUEST) - half));
        new_loop();
        CHECK(handshakes_ok == 1 && FCV_ETHCLIENTCONNECTED == 1, "completed request: handshake runs and reports a new client");
    }
    CHECK(wiped_established == 0 && handshakes_400 == 0, "established connection is never wiped, no 400 sent");
    CHECK(rsr() == 0, "the consumed upgrade request is handed back to the chip (Sn_RX_RD advanced)");

    printf("NEW loop, frames after the handshake:\n");
    client_sends_frame("{\"hi\":1}");
    new_loop();
    CHECK(FCV_ETHCLIENTCONNECTED == 2 && strcmp((char *)rxdata, "{\"hi\":1}") == 0, "first frame arrives intact (not the old request)");
    new_loop();
    CHECK(FCV_ETHCLIENTCONNECTED == 0 && ws_connected, "no phantom frame afterwards");
    {
        int ok = 1, k;
        char msg[32];
        for (k = 0; k < 120; k++) /* ~3 KB through a 2 KB buffer: pointer wraps */
        {
            snprintf(msg, sizeof msg, "{\"readsensors\":%d}", k);
            client_sends_frame(msg);
            new_loop();
            if (FCV_ETHCLIENTCONNECTED != 2 || strcmp((char *)rxdata, msg) != 0) { ok = 0; break; }
        }
        CHECK(ok, "120 consecutive frames (3 KB, buffer wraps) all arrive intact");
    }

    printf("NEW loop, stale messages in the command queue:\n");
    reset();
    for (i = 0; i < 3; i++) { new_loop(); }
    client_connects_and_sends_request(); new_loop();
    CHECK(handshakes_ok == 1, "client connected");
    queue_put(901); queue_put(902); queue_put(903); /* left over from earlier traffic */
    client_sends_frame("{\"macinfo\":0}");
    new_loop();
    CHECK(FCV_ETHCLIENTCONNECTED == 2, "a frame was received");
    queue_put(77); /* APIProcess copies the new frame into the queue after EthPoll returns */
    CHECK(queue_parse() == 77, "ParseJSON gets this frame, not an old message (replies stay in step)");
    CHECK(FCV_COMMSSTATE == 0, "message state machine is reset with the queue");
    {
        int before = flushes;
        for (i = 0; i < 10; i++) { new_loop(); }
        CHECK(flushes == before, "idle passes do not touch the queue");
    }
    reset();
    new_loop();
    queue_put(5);
    client_connects_and_sends_request(); new_loop();
    CHECK(cmdq_n == 0, "a new client starts with an empty queue");

    printf("NEW loop, frame split across two segments:\n");
    {
        MX_UINT8 f[40];
        const MX_UINT8 m[4] = {1, 2, 3, 4};
        const char *t = "{\"readsensors\":0}";
        MX_UINT16 n = (MX_UINT16)strlen(t), i2;
        int frames_before = frames;
        f[0] = 0x81; f[1] = (MX_UINT8)(0x80 | n); memcpy(f + 2, m, 4);
        for (i2 = 0; i2 < n; i2++) { f[6 + i2] = (MX_UINT8)t[i2] ^ m[i2 & 3]; }
        push(f, 10);
        for (i = 0; i < 3; i++) { new_loop(); }
        CHECK(frames == frames_before && ws_connected, "a partly arrived frame is not decoded");
        push(f + 10, (MX_UINT16)(6 + n - 10));
        new_loop();
        CHECK(FCV_ETHCLIENTCONNECTED == 2 && strcmp((char *)rxdata, t) == 0, "the frame is delivered intact once the rest arrives");
    }

    printf("OLD loop reading the same traffic (no commit):\n");
    reset();
    sr = SR_ESTAB; FCV_05061_NetworkComms1__CLOSED = 0;
    push((const MX_UINT8 *)REQUEST, (MX_UINT16)strlen(REQUEST));
    old_loop();
    client_sends_frame("{\"hi\":1}");
    old_loop();
    CHECK(!(FCV_ETHCLIENTCONNECTED == 2 && strcmp((char *)rxdata, "{\"hi\":1}") == 0), "the first frame is NOT delivered: stale request is re-read instead");

    printf("client vanishes (FIN, no close frame):\n");
    reset();
    for (i = 0; i < 2; i++) { new_loop(); }
    client_connects_and_sends_request(); new_loop(); new_loop();
    sr = SR_CLOSE_WAIT;
    new_loop();
    CHECK(closelinks == 1 && FCV_ETHCLIENTCONNECTED == 3, "link is closed and 'client gone' (3) reported");
    new_loop();
    CHECK(sr == SR_LISTEN, "listener is re-opened for the next client");

    printf("silent client holds the socket:\n");
    reset();
    new_loop();
    sr = SR_ESTAB;
    for (i = 0; i < 100; i++) { new_loop(); }
    CHECK(sr == SR_ESTAB, "still held after 100 passes");
    for (i = 0; i < 3; i++) { new_loop(); }
    CHECK(sr == SR_LISTEN, "dropped after the idle limit and listening again");

    printf("failed handshake (garbage request):\n");
    reset();
    new_loop();
    sr = SR_ESTAB; push((const MX_UINT8 *)"hello", 5);
    for (i = 0; i < 25; i++) { new_loop(); }
    CHECK(handshakes_ok == 0 && sr == SR_LISTEN, "garbage with no CRLFCRLF never reaches the handshake loop (it would spin for ever); socket is recycled");
    sr = SR_ESTAB; push((const MX_UINT8 *)"GET / HTTP/1.1\r\nHost: x\r\n\r\n", 30);
    new_loop();
    CHECK(handshakes_ok == 1, "a complete header after that is handled normally");

    printf("port/address changed while listening:\n");
    reset();
    new_loop();
    create_calls = 0;
    FCV_05061_NetworkComms1__CLOSED = 1; /* WebSocket1.CreateServerSocket */
    new_loop(); new_loop();
    CHECK(create_calls == 1 && sr == SR_LISTEN, "listener is re-created exactly once");

    printf("SYN in progress is left alone:\n");
    reset();
    new_loop();
    sr = SR_SYNRECV; create_calls = 0;
    new_loop(); new_loop();
    CHECK(create_calls == 0 && sr == SR_SYNRECV, "socket in SYNRECV is not touched");

    printf("USB receive path:\n");
    reset();
    USBDeviceState = 0; FCV_COMMSUSBACTIVE = 1;
    new_loop();
    CHECK(FCV_COMMSUSBACTIVE == 0, "no host (device not configured): USB reads are switched off");
    USBDeviceState = 0x04; new_loop();
    CHECK(FCV_COMMSUSBACTIVE == 0, "default/address states (still enumerating) stay off");
    USBDeviceState = 0x20; new_loop();
    CHECK(FCV_COMMSUSBACTIVE == 1, "host has configured the device: USB reads on");
    USBDeviceState = 0; new_loop();
    CHECK(FCV_COMMSUSBACTIVE == 0, "cable removed: off again");

    printf("%s\n", fails ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
    return fails ? 1 : 0;
}
