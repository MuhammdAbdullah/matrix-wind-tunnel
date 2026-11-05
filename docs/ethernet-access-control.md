# Ethernet access control and network identity (firmware V2.0.7 + access-control patch)

Status: **written against the edited `../Firmware/WindTunnel V2.0.7.fcfx`. Not compiled in Flowcode and not run on hardware.** The `.hex`/`.c` in `Firmware/` are still the old build until the `.fcfx` is rebuilt in Flowcode. Originals are in `Firmware/Archive/pre-auth-backup/`.

This stops accidental and casual connections: a browser, a port scanner, an old app or any other program that does not speak the Wind Tunnel handshake is dropped. **It is not a secret and not cryptography.** The handshake words are fixed and written down here, so anyone who reads this file (or sniffs the LAN once) can replay them. There is deliberately no key for the operator to manage; if real security is ever needed, add a per-controller secret on top of this handshake.

## Rules

1. **USB is the master and always wins.** USB needs no handshake. The controller treats USB as live when it has received any USB command in the last ~6-12 s (the app's 1.5 s heartbeat keeps it live). While USB is live, an Ethernet client is sent `{"auth":2}` and closed, and new Ethernet clients are refused the same way.
2. **Ethernet works only when USB is not live, and only after the handshake.** Anything an unverified Ethernet client sends other than the next handshake step gets `{"auth":0}` and the socket is closed. No handshake within ~5-10 s: `{"auth":4}` and closed.
3. **A client that fails the handshake makes the controller renew its address** (DHCP request again; with a fixed IP nothing changes). At most once per ~30 s. USB-in-control rejections do not trigger it. Most routers hand back the same address, so the IP may or may not actually change: the operator re-reads it on the touchscreen.
4. The fan is not touched by an unverified or rejected client. A verified session still starts with fan 0 and a disconnect of a verified session still sets fan 0 (as V2.0.7 did for any client).

## The operator's view

Read the controller's IP on its touchscreen (Settings page) -> type it in Admin -> Network -> press Connect. Nothing else to set up. If it stops working, read the touchscreen again (the IP may have changed after the controller dropped an unknown device).

## Handshake (Ethernet, JSON text frames, one object per frame)

```
app -> controller   {"hi":1}        "Hi"
controller -> app   {"hey":1}       "Hey"
app -> controller   {"com":1}       "COM"
controller -> app   {"ok":1}        "OK"   (verified; normal API from now on)
```

Terminal replies (then the controller closes the socket): `{"auth":0}` wrong or out-of-order message / unverified command, `{"auth":2}` USB has control, `{"auth":4}` timed out. The firmware matches the key names `hi` and `com` in the received JSON (`FindName`, substring match) and ignores the values; an unverified message is never run as a command, even if it also carries one.

A controller without this patch never answers `hi` (it ignores unknown keys). The app treats "no `hey` within ~1.5 s of connecting" as legacy firmware and continues unauthenticated.

## New and changed API (all flat JSON, same style as the existing API)

| Request | Reply | Notes |
|---|---|---|
| `{"netinfo":0}` | `{"ip":"a.b.c.d","port":1245,"dhcp":1}` | `ip` is the live address (DHCP lease or static). |
| `{"macinfo":0}` | `{"mac":"00:08:DC:00:00:00","sip":"192.168.1.150"}` | `sip` is the stored static IP (the DHCP-off address). |
| `{"ip0":a,"ip1":b,"ip2":c,"ip3":d,"port":p,"dhcp":d}` and, **before it, in a separate frame**, `{"mac0":..,"mac5":..}` | none | Existing set-network command plus the new, optional MAC frame (decimal bytes). **They must be two frames:** the firmware reads a request into a 100-byte buffer (`FCM_ParseJSON`, `FCL_JSON_DATA[100]`), and the combined frame is up to 124 characters, so it is cut off before `mac4`/`mac5`/`dhcp` and the MAC is silently ignored (and the 24 extra bytes overrun the stack buffer). The MAC frame is stored when it arrives; it reaches the W5500 when the following frame's `dhcp` makes the controller re-apply the network (the controller re-applies the network only when `dhcp` is present, as before). The MAC is stored in EEPROM words 46-51 (the flasheeprom2 component writes straight to flash; the firmware checks each `Write` result and reads every word back, and only then uses the new MAC, so a failed save leaves the old MAC in force) and applied before DHCP/static IP. **The first three bytes (the OUI) are fixed at `00:08:DC`**, the WIZnet block the W5500 ships with (multicast bit 0 and locally-administered bit 1 both clear, so it is unicast and globally unique); a request whose `mac0..mac2` are not `0, 8, 220` is ignored as a whole, as is one with a missing or out-of-range field. Only `mac3..mac5` (the NIC specific part) are free. |

MAC default when EEPROM word 46 is blank (or holds a MAC with another OUI, which `LoadMAC` refuses): the W5500 component's `00:08:DC:00:00:00` (unchanged from V2.0.7). Every unit ships with that same MAC, so two controllers on one LAN will collide until one is given a different last three bytes. Writing `00:08:DC:00:00:00` back restores the default.

**Who can change it:** only the Admin -> Network tab (`#networkMac` holds just the last three bytes; the prefix is shown fixed). `calibration:setNetwork` is Admin-gated in the main process (`guard()`), the renderer re-asks for the Admin password if the session lapsed, and the relay never exposes it. The touchscreen only displays the MAC. The app validates with `netinfo.macProblem()`; the firmware enforces the same rule independently.

## EEPROM map additions (word addresses, 16-bit cells)

| Address | Content |
|---|---|
| 46-51 | MAC bytes 0-5 (blank = `0xFFFF` in word 46 means "use default MAC"; bytes 0-2 must be `00 08 DC`, otherwise the stored MAC is ignored) |

(Words 42-45 were used by an earlier keyed draft of this feature and are now unused.)

## Touchscreen

Settings screen additionally shows `Port : <n>` and `MAC : <12 hex digits>` under the IP line (y positions 220 and 250 are a guess: check on hardware).

## App behaviour (main/ethernet.js, main/netinfo.js)

- `EthernetPort` sends `{"hi":1}` as soon as the WebSocket opens, answers `{"hey":1}` with `{"com":1}` and only reports the link open after `{"ok":1}`. Handshake frames never reach the command layer. No `hey` within 1.5 s = legacy firmware, continue unauthenticated. Total handshake budget ~6 s.
- Failure codes: `USB_IN_CONTROL` (`auth:2`), `AUTH_FAILED` (`auth:0`), `AUTH_TIMEOUT` (`auth:4` or the app's own budget). After a refusal the scanner waits 15 s before trying Ethernet again. The Admin banner for `AUTH_FAILED`/`AUTH_TIMEOUT` tells the operator to re-read the IP on the touchscreen.
- The set-network read-back (USB only) compares `netinfo`/`macinfo` with the request; over Ethernet the link drops while the controller re-applies the network, so no read-back is attempted.
- `probe()` (network scan) returns the API version, or `{ locked: 'usb-in-control' | 'refused' | 'timeout' }`, or `null`. Scanning runs the handshake against every host, so it only finds controllers that answer it.
- Self-tests: `npm run test:netauth` runs the app side against `tools/mock-controller.js`; `python tools/firmware-auth-test/run.py` extracts the embedded C from the `.fcfx` and runs it under gcc with stubs (logic only: it does not prove the firmware compiles under Flowcode/XC16). `tools/firmware-auth-test/patch-fcfx.js` re-creates the edits from `Firmware/Archive/pre-auth-backup/`.
