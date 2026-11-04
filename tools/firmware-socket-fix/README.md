# Ethernet socket fix (firmware V2.0.7)

Symptom (2026-11-03, controller at 192.168.1.150, also over a direct cable, also with the pre-access-control build): TCP connects, then every client gets `ECONNRESET` before the WebSocket upgrade finishes. Captures (`pktmon`) show SYN-ACK from the W5500, then an RST (or an unacknowledged request and an RST on retransmit). Never a `101`, a `400` or an `{"auth":N}`.

## Cause (read from `Firmware/WindTunnel V2.0.7.c`; not yet confirmed on hardware)

`APIProcess` calls `WebSocket1.CheckSocketActivity()` every main loop. In server mode that calls `NetworkComms1.AcceptOpen()`, which **always returns 1**, so `Prv_Handshake()` runs on every pass, even with no client. `Prv_Handshake()` does not wait for data (`NetworkComms1.Receive()` ignores its timeout argument), so with nothing in the buffer it sends `400 Bad Request` and `AcceptClose()` sets `NetworkComms1.CLOSED = 1`. On the next pass `AcceptOpen()` sees `CLOSED` and calls `W5500.CreateTCPSocket()`, which sends a W5500 `CLOSE` to any socket that is not already closed: **a connection that was accepted in the meantime is destroyed silently before its request is read.** Because `TCPClose()` waits up to 100 ms for `SEND_OK`, each pass is also slow, which is why the window is large and the failure is near-100 %.

## Second bug, found on hardware after the first fix (2026-11-03)

With the first fix flashed, the upgrade succeeded (`101`) but the controller answered the client's first frame with a bare close frame (`88 00`) and a FIN. `pktmon` showed the window only shrinking (2048, 1821, 1807): **the driver never releases received bytes.** `RxDataAvailable` re-derives its read pointer from `Sn_RX_RD`, `RxReadArray` advances only a RAM copy (`GRXPTR`), the flush in `NetworkComms.Receive` is under `#if 0`, and nothing writes `Sn_RX_RD` or issues `RECV`. Every read therefore starts again at the oldest unconsumed byte, which after the handshake is the `GET / HTTP/1.1` request, decoded as a close frame. The same flaw means a handshake with no `CRLFCRLF` in the buffer re-reads the same bytes for ever (the try counter resets every time bytes are returned), so junk sent to port 1245 would freeze the main loop.

`EthPoll` therefore also: writes `Sn_RX_RD = GRXPTR` and issues `RECV` after each pass that read data; starts the handshake only when a complete HTTP header is in the buffer; reads a frame only when all of it has arrived; and drops clients whose request or frame never completes.

## Third and fourth problems (2026-11-03, after the receive fix)

- **Stale command queue.** `ParseJSON` answers the message at the front of the shared circular command buffer and the buffer is never cleared, so one leftover message from earlier traffic shifts every later reply by one (a heartbeat `version` was answered with a sensor reading, the Hi/COM gate judged an old message and sent `auth:0`, and the app's watchdog dropped the link after 11 s). `EthPoll` now empties the buffer (`FlushBuffer`, `COMMSSTATE = 0`) when a client connects or leaves, when a frame arrives and when the socket is re-opened. Confirmed on hardware with a recorder build: 199 frames in, 199 messages parsed, every reply matching its request, app streaming sensor data.
- **Slow recovery after a cable unplug/replug (~30 s).** The old session is only dropped by the WebSocket keepalive (ping after 100 idle polls, close after three unanswered pings), and while it lingers the single socket refuses new connections. `PingIdle` is now 25 (generated C and the component property in the `.fcfx`), roughly 5-10 s.
- **Blackout after any failed client.** `EthReject` set `AuthRenew`, which re-ran DHCP (blocking the main loop 5 s or more) after every failed handshake, so a stray connection made the controller unreachable. Removed (the line is commented in `EthReject`). With a direct cable there is no DHCP server for it to find anyway.

## Root cause of the "works sometimes" behaviour: phantom USB traffic (found 2026-11-03)

A recorder build (`{"dbg":0}`) showed 186 Ethernet frames but 2476 parsed messages, the recent ones all from USB (`zeromotor`, `version`, `zeromotor`, `version`) with no USB cable attached. Microchip's `getsUSBUSART` (used by the Flowcode USB read) treats a missing descriptor handle as "a packet is ready" and returns the contents of its receive buffer again on every call, so with no host the controller replays the last commands it ever received, endlessly. Consequences: the main loop and stepper are kept busy (`zeromotor`), so Ethernet handshakes time out and recovery can take minutes; the controller looks like it has a live USB host (`auth:2`, the USB-priority check); and stale messages are interleaved with real ones in the shared command queue (replies out of step, `auth:0`). Fix: `EthPoll` sets `CommsUSBActive = (USBDeviceState >= CONFIGURED_STATE)` every pass, so USB is only read while a host has configured the device. Not yet confirmed on hardware.

## Fix

New macro `EthPoll` (`ethpoll.c`) replaces the `CheckSocketActivity` call in `APIProcess`:

- looks at the real W5500 socket state (`Sn_SR`) instead of the component's `CLOSED` flag;
- opens and listens only when the socket is closed (or `CreateServerSocket` flagged a port/address change);
- leaves `LISTEN` and `SYNRECV` alone and never re-creates an `ESTABLISHED` socket;
- runs the handshake (via `CheckSocketActivity`) only once the request is in the RX buffer, after one settle pass;
- drops a silent connection after 100 passes;
- when a client vanished (FIN/RST, socket not `ESTABLISHED`, nothing left to read) calls `Prv_CloseLink()` and reports "client gone" (3), where before only a close frame or the keepalive timeout noticed.

## Files

- `apply.js fcfx <file>`: patches a Flowcode project (the source of truth; open it in Flowcode and compile as usual).
- `apply.js generated <folder>`: patches generated `.c`/`.h` so the image can be built without the IDE using Flowcode's own batch files (`pic16_C30_comp.bat`, `pic16_C30_link.bat`). The unmodified current source built this way reproduces Flowcode's `.hex` bit-for-bit.
- `harness.c`: host-side model of the W5500 socket and the component's accept/handshake; the old loop destroys the connection, `EthPoll` does not. Logic only. `gcc -o harness harness.c && ./harness`.
- Built images and patched projects: `Firmware/Socket fix/A - old firmware plus fix` (pre-access-control build + fix) and `.../B - current firmware plus fix` (current build with access control + fix).

Verify on hardware before treating any of this as confirmed: the harness encodes the reading above, it cannot show the real timing.
