static void feed(int src, const char *json) { FCV_COMMSSOURCE = src; JSON = json; FCV_AUTHPROCEED = 1; FCM_AuthGate(); }
static int check(const char *what, int ok) { printf("%s %s\n", ok ? "PASS" : "FAIL", what); return ok ? 0 : 1; }
static void newClient(void) { connected = 1; wires = 0; FCV_AUTHSTATE = 0; FCM_EthClientEvent(1); }
// Runs the loop until a pending renewal has had its chance (the socket is closed by then).
static void loops(int n) { int i; for (i = 0; i < n; i++) FCM_AuthSession(); }

int main(void)
{
    int f = 0; int i;

    memset(EE, 0xFF, sizeof EE); FCM_LoadMAC();
    f += check("blank EEPROM = no stored MAC", FCV_ETHMACSET == 0);
    FCM_ApplyMAC(); f += check("no MAC -> ApplyMAC does nothing", mac_applied[0] == 0);

    // ---- the handshake: Hi -> Hey, COM -> OK
    FCV_USBIDLE = 1000; fan = 55; newClient();
    f += check("new client: no key needed, waits for Hi, nothing sent", FCV_AUTHSTATE == 1 && wires == 0 && connected == 1);
    feed(FCV_COMMS_SOURCE_ETH, "{\"hi\":1}");
    f += check("Hi -> {hey:1}, still gated", FCV_AUTHSTATE == 2 && strcmp(wire[wires - 1], "{\"hey\":1}") == 0 && FCV_AUTHPROCEED == 0 && connected == 1);
    feed(FCV_COMMS_SOURCE_ETH, "{\"com\":1}");
    f += check("COM -> {ok:1}, verified, fan 0", FCV_AUTHSTATE == 3 && strcmp(wire[wires - 1], "{\"ok\":1}") == 0 && fan == 0 && FCV_AUTHPROCEED == 0 && connected == 1);
    feed(FCV_COMMS_SOURCE_ETH, "{\"readsensors\":0}");
    f += check("verified client: commands pass the gate", FCV_AUTHPROCEED == 1);
    feed(FCV_COMMS_SOURCE_USB, "{\"readsensors\":0}");
    f += check("USB commands always pass the gate", FCV_AUTHPROCEED == 1);
    FCV_AUTHRENEW = 0;

    // ---- anything else is dropped
    dhcp_runs = 0; FCV_AUTHRENEWHOLD = 0; fan = 77; newClient();
    feed(FCV_COMMS_SOURCE_ETH, "{\"fanspeed\":100}");
    f += check("command before Hi -> {auth:0}, dropped, fan untouched", strcmp(wire[wires - 1], "{\"auth\":0}") == 0 && connected == 0 && fan == 77 && FCV_AUTHPROCEED == 0);
    newClient(); feed(FCV_COMMS_SOURCE_ETH, "{\"com\":1}");
    f += check("COM without Hi -> dropped", strcmp(wire[wires - 1], "{\"auth\":0}") == 0 && connected == 0);
    newClient(); feed(FCV_COMMS_SOURCE_ETH, "{\"hi\":1}"); feed(FCV_COMMS_SOURCE_ETH, "{\"hi\":1}");
    f += check("Hi twice -> dropped", strcmp(wire[wires - 1], "{\"auth\":0}") == 0 && connected == 0 && FCV_AUTHSTATE == 0);
    newClient(); feed(FCV_COMMS_SOURCE_ETH, "{\"hi\":1}"); fan = 66; feed(FCV_COMMS_SOURCE_ETH, "{\"fanspeed\":100}");
    f += check("command instead of COM -> dropped, fan untouched", strcmp(wire[wires - 1], "{\"auth\":0}") == 0 && connected == 0 && fan == 66);
    newClient(); feed(FCV_COMMS_SOURCE_ETH, "{\"hi\":1,\"fanspeed\":100}");
    f += check("Hi bundled with a command never runs the command", FCV_AUTHPROCEED == 0);
    newClient(); feed(FCV_COMMS_SOURCE_ETH, "{\"version\":0}");
    f += check("legacy app (no Hi) -> dropped", strcmp(wire[wires - 1], "{\"auth\":0}") == 0 && connected == 0);

    // ---- timeout
    FCV_AUTHRENEWHOLD = 0; newClient();
    for (i = 0; i < 99; i++) FCM_AuthSession();
    f += check("silent client not dropped before the timeout", connected == 1);
    for (i = 0; i < 3; i++) FCM_AuthSession();
    f += check("silent client dropped after timeout with {auth:4}", connected == 0 && strcmp(wire[wires - 1], "{\"auth\":4}") == 0);
    newClient(); feed(FCV_COMMS_SOURCE_ETH, "{\"hi\":1}");
    for (i = 0; i < 103; i++) FCM_AuthSession();
    f += check("client that never sends COM is dropped too", connected == 0 && strcmp(wire[wires - 1], "{\"auth\":4}") == 0);

    // ---- a failed client makes the controller renew its address (DHCP), once per cool-down
    connected = 0; FCV_AUTHRENEW = 0; FCV_AUTHRENEWHOLD = 0; dhcp_runs = 0; sockets_created = 0; FCV_DHCPENABLE = 1; FCV_USBIDLE = 1000;
    newClient(); feed(FCV_COMMS_SOURCE_ETH, "{\"bogus\":1}");
    f += check("rejection asks for a renewal but does not block in the handler", FCV_AUTHRENEW == 1 && dhcp_runs == 0);
    FCM_AuthSession();
    f += check("client gone -> DHCP re-run and server socket re-created", dhcp_runs == 1 && sockets_created == 1 && FCV_AUTHRENEW == 0 && FCV_AUTHRENEWHOLD > 0);
    newClient(); feed(FCV_COMMS_SOURCE_ETH, "{\"bogus\":1}"); FCM_AuthSession();
    f += check("second failure inside the cool-down: no second renewal", dhcp_runs == 1 && FCV_AUTHRENEW == 0);
    loops(601);
    newClient(); feed(FCV_COMMS_SOURCE_ETH, "{\"bogus\":1}"); FCM_AuthSession();
    f += check("after the cool-down it renews again", dhcp_runs == 2);
    FCV_AUTHRENEWHOLD = 0; FCV_DHCPENABLE = 0; newClient(); feed(FCV_COMMS_SOURCE_ETH, "{\"bogus\":1}"); FCM_AuthSession();
    f += check("fixed IP: nothing to renew", dhcp_runs == 2);
    FCV_DHCPENABLE = 1; FCV_AUTHRENEWHOLD = 0; FCV_AUTHRENEW = 0; dhcp_runs = 0;
    newClient(); feed(FCV_COMMS_SOURCE_ETH, "{\"hi\":1}"); feed(FCV_COMMS_SOURCE_ETH, "{\"com\":1}"); FCV_AUTHSTATE = 0; connected = 0; FCM_AuthSession();
    f += check("a verified client that leaves does not trigger a renewal", dhcp_runs == 0);

    // ---- USB always wins
    connected = 1; wires = 0; FCV_AUTHSTATE = 3; FCV_USBIDLE = 1000; FCV_AUTHRENEW = 0; FCM_AuthSession();
    f += check("verified Ethernet client survives while USB idle", connected == 1);
    FCV_USBIDLE = 0; FCM_AuthSession();
    f += check("USB traffic -> Ethernet client dropped with {auth:2}", connected == 0 && strcmp(wire[wires - 1], "{\"auth\":2}") == 0 && FCV_AUTHSTATE == 0);
    f += check("USB drop does not renew the address", FCV_AUTHRENEW == 0);
    connected = 1; wires = 0; FCV_USBIDLE = 3; FCM_EthClientEvent(1);
    f += check("new Ethernet client while USB live -> {auth:2}", strcmp(wire[0], "{\"auth\":2}") == 0 && connected == 0);
    connected = 1; wires = 0; FCV_USBIDLE = 1000; FCV_AUTHSTATE = 0; FCM_EthClientEvent(1); feed(FCV_COMMS_SOURCE_ETH, "{\"hi\":1}"); FCV_USBIDLE = 1;
    feed(FCV_COMMS_SOURCE_ETH, "{\"com\":1}");
    f += check("USB goes live mid-handshake -> rejected, no OK", strcmp(wire[wires - 1], "{\"auth\":2}") == 0 && connected == 0 && FCV_AUTHSTATE == 0);
    connected = 0; FCV_USBIDLE = 0; for (i = 0; i < 119; i++) FCM_AuthSession();
    f += check("USB still live at 119 idle loops", FCV_USBIDLE < WT_USB_LIVE_LOOPS);
    for (i = 0; i < 3; i++) FCM_AuthSession();
    f += check("USB no longer live after 120+ idle loops", FCV_USBIDLE >= WT_USB_LIVE_LOOPS);
    fan = 40; FCV_AUTHSTATE = 1; FCM_EthClientEvent(3); f += check("unverified client leaving leaves fan alone", fan == 40 && FCV_AUTHSTATE == 0);
    FCV_AUTHSTATE = 3; FCM_EthClientEvent(3); f += check("verified client leaving -> fan 0", fan == 0 && FCV_AUTHSTATE == 0);
    connected = 1; FCV_AUTHSTATE = 0; FCV_USBIDLE = 1000; wires = 0; FCM_AuthSession();
    f += check("connected client with no session state is dropped", connected == 0 && strcmp(wire[wires - 1], "{\"auth\":0}") == 0);

    // ---- network info, MAC
    FCV_COMMSSOURCE = FCV_COMMS_SOURCE_USB; JSON = "{\"netinfo\":0}"; FCM_NetApiExtra();
    f += check("netinfo reply", strcmp(reply, "{\"ip\":\"10.0.0.7\",\"port\":1245,\"dhcp\":1}") == 0); puts(reply);
    JSON = "{\"macinfo\":0}"; FCM_NetApiExtra();
    f += check("macinfo reply", strcmp(reply, "{\"mac\":\"00:08:DC:00:00:00\",\"sip\":\"192.168.1.150\"}") == 0); puts(reply);
    JSON = "{\"mac0\":2,\"mac1\":171,\"mac2\":205,\"mac3\":239,\"mac4\":1,\"mac5\":35,\"dhcp\":1}"; FCM_NetApiExtra();
    f += check("MAC stored + flagged", FCV_ETHMACSET == 1 && FCV_ETHMAC[0] == 2 && FCV_ETHMAC[5] == 35 && EE[46] == 2 && EE[51] == 35);
    FCM_ApplyMAC(); f += check("ApplyMAC writes it to the W5500", strcmp(mac_applied, "02abcdef0123") == 0);
    JSON = "{\"mac0\":3,\"mac1\":1,\"mac2\":1,\"mac3\":1,\"mac4\":1,\"mac5\":1}"; FCM_NetApiExtra();
    f += check("multicast MAC ignored", FCV_ETHMAC[0] == 2);
    JSON = "{\"mac0\":0,\"mac1\":0,\"mac2\":0,\"mac3\":0,\"mac4\":0,\"mac5\":0}"; FCM_NetApiExtra();
    f += check("all-zero MAC ignored", FCV_ETHMAC[0] == 2);
    JSON = "{\"mac0\":2,\"mac1\":1,\"mac2\":1,\"mac3\":1,\"mac4\":1,\"mac5\":300}"; FCM_NetApiExtra();
    f += check("out-of-range MAC byte ignored", FCV_ETHMAC[1] == 171);
    JSON = "{\"mac0\":2,\"mac1\":1}"; FCM_NetApiExtra();
    f += check("partial MAC ignored", FCV_ETHMAC[1] == 171);
    FCV_ETHMACSET = 0; memset(FCV_ETHMAC, 0, 6); FCM_LoadMAC();
    f += check("MAC persisted in EEPROM 46-51", FCV_ETHMACSET == 1 && FCV_ETHMAC[0] == 2 && FCV_ETHMAC[5] == 35);
    FCV_066a1_TCP_IP_W5500__MY_MAC[0] = 2; FCV_066a1_TCP_IP_W5500__MY_MAC[1] = 0xAB; FCV_066a1_TCP_IP_W5500__MY_MAC[2] = 0xCD;
    FCV_066a1_TCP_IP_W5500__MY_MAC[3] = 0xEF; FCV_066a1_TCP_IP_W5500__MY_MAC[4] = 1; FCV_066a1_TCP_IP_W5500__MY_MAC[5] = 0x23;
    screenfn();
    f += check("touchscreen lines", strcmp(screen[0], "220:Port : 1245") == 0 && strcmp(screen[1], "250:MAC : 02ABCDEF0123") == 0); puts(screen[0]); puts(screen[1]);
    printf("%s (%d failures)\n", f ? "FAILED" : "ALL PASS", f);
    return f;
}
