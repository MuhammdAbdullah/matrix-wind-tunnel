# Wind Tunnel

Windows Electron desktop application for the Matrix Wind Tunnel. It combines the former **Wind Tunnel Control** and **Wind Tunnel Calibrator** tools in one app: live sensor readout, fan and angle control, the 8-experiment suite with angle/fan sweeps and CSV logging, scaler/velocity-LUT calibration, and Admin-gated firmware (bootloader) updates.

## Contents

- [What the app does](#what-the-app-does)
- [Getting started](#getting-started)
- [How it works](#how-it-works)
- [Ethernet and remote access](#ethernet-and-remote-access)
- [Experiments](#experiments)
- [API reference](#api-reference)
  - [Renderer API (`window.windTunnel`)](#renderer-api-windwindtunnel)
  - [Push events](#push-events)
  - [State object](#state-object)
  - [Controller serial protocol](#controller-serial-protocol)
- [Files written by the app](#files-written-by-the-app)
- [Safety and Git boundary](#safety-and-git-boundary)
- [Release notes](#release-notes)

## What the app does

| Area | Capability |
|---|---|
| **Connection** | Scans for the controller (USB VID `0x12BF`, PID `0xF010`), connects at `115200` baud, verifies API version `2`, and drops the link immediately on unplug and within 8 s if the controller stops answering, and reconnects automatically (rescanning by VID/PID). USB is always preferred; with no USB controller the app can connect over **Ethernet** instead (V2.0.7 firmware, WebSocket). |
| **Control** | Live lift (mN), drag (mN), pressure (Pa) and air velocity (m/s); fan speed `0–100 %`; motor angle `-180°…180°`; zero sensors; zero motor; LED animation/ambient settings. |
| **Experiments** | Eight experiments (pressure-to-velocity, pressure-tapped cylinder/aerofoil, lift, drag, stem racing, sensors vs time, custom X/Y), each with its own traces, axes and CSV columns. A live chart and an experiment-history chart are kept separate. |
| **Sweeps** | Timed angle sweeps and fan-speed sweeps that move the actuator, wait for it to settle, read the sensors, log a point and advance. |
| **Logging** | CSV files (`WindTunnelLog_<timestamp>.csv` style) in a configurable folder; the save location is asked once per experiment. |
| **Admin** | Password-gated area (10-minute session) with diagnostics (raw TX/RX, retry/error counters, activity log), sensor scalers, 10-point velocity LUT (guided 10 %-step pressure capture converted to air speed, saved with one Save Table button), display calibration, network IP/port, HID bootloader firmware update, app-update status and an audit trail. |
| **Network** | Admin > Network: controller IP / DHCP / port, Ethernet connection with network scan, **remote access** (other PCs, tablets and phones can watch or also control through the master PC, set to *off*, *view only* or *view and control*), discovery of masters on the LAN, and connecting this app to another PC as a remote client. See [Ethernet and remote access](#ethernet-and-remote-access). |
| **Simulation** | `--simulate` replaces the hardware with synthetic sensor data for development without a tunnel. |

## Getting started

Requirements: Windows, Node.js, and (for real hardware) the Wind Tunnel controller on USB, or on the network over Ethernet (controller firmware V2.0.7 or newer).

```powershell
npm install
npm start             # auto-scans for the real USB controller
npm run simulate      # synthetic sensor data, no hardware needed
npm run dev           # Electron with --dev flag
npm run build-win     # electron-builder Windows NSIS installer -> dist/
npm run rebuild-hid   # rebuild the native node-hid module against Electron's ABI
```

The production build shows "Searching for controller…" and connects as soon as the approved device appears. Simulation is opt-in only (`npm run simulate`, or `WIND_TUNNEL_SIMULATION=1`). There is no automated test suite — verify changes with `npm run simulate` and/or against real hardware. DevTools: `Ctrl+Shift+I`.

## How it works

```
┌─────────────────────────── Renderer (renderer/) ───────────────────────────┐
│ index.html + app.js + charts.js (Chart.js)   no framework, no bundler       │
│        calls window.windTunnel.*      ▲ receives state:update etc.          │
└────────────────┬────────────────────────┴───────────────────────────────────┘
                 │ contextBridge (preload.js)  — contextIsolation on, nodeIntegration off
┌────────────────▼───────────────────────────────────────────────────────────┐
│ main.js — window creation + ipcMain.handle wiring                           │
│  main/state.js        single shared state, publish() → renderer             │
│  main/serial.js       SerialPort transport, command queue, auto-connect     │
│  main/protocol.js     binary framing  ':' cmd payload ';\n'                 │
│  main/experiments.js  declarative 8-experiment table                        │
│  main/sweeps.js       sensor-sample timer, angle/fan sweeps, Log Point      │
│  main/logging.js      CSV output                                            │
│  main/calibration.js  scalers / LUT / display / network (Admin-gated)       │
│  main/admin.js        scrypt password hash, 10-minute session               │
│  main/bootloader.js   HID bootloader protocol  ─ main/firmware.js (gated)   │
│  main/ethernet.js     WebSocket link to the controller (Ethernet)           │
│  main/network.js      relay for other devices, discovery, remote client     │
│  main/control.js      fan/angle/zero/LED commands (local or forwarded)      │
└────────────────┬───────────────────────────────────────────────────────────┘
                 │ USB serial 115200 baud   or   Ethernet WebSocket :1245   USB HID (bootloader)
            Wind Tunnel controller (firmware V2.0.7)
```

**Process boundary.** The renderer never touches serial, HID or the filesystem. It only calls `window.windTunnel.*`, which maps 1:1 to `ipcMain.handle` channels in `main.js`.

**One source of truth.** `main/state.js` holds one `state` object. Every change calls `publish()`, which pushes the whole object to the renderer on `state:update`; the renderer re-derives all gauges, labels and charts from each snapshot.

**Connection.** `serial.startAutoConnect()` rescans `SerialPort.list()` every 2 s while disconnected and matches VID/PID each time, so a controller that comes back on a different COM number is found. After opening, the API version is read (`A`) and must equal `2` before the app reports Connected (a port that does not answer is closed). An unplug, port error or write failure drops the link immediately; a controller that stays enumerated but stops answering is detected by a watchdog (heartbeat when idle, "Not responding" after 3 s, link dropped after 8 s). Queued commands are discarded on loss so nothing replays onto the new session. A manual Disconnect is not treated as a fault, but the scanner reconnects within a couple of seconds.

**Command queue.** `sendBinary()` chains every command onto one promise so only one command is ever in flight; each is retried on timeout, recorded in the TX/RX diagnostics and tagged with its source (`control`, `calibrator`, `system`) in the audit log.

**Sensor polling.** A 1 s timer reads sensors (`C`) and publishes. While a sweep runs, the sweep tick does the read itself so no duplicate round-trips occur.

**Sweeps.** `sweep:startAngle` / `sweep:startFan` first make sure a CSV is open (asking for a save location once per experiment; repeated sweeps of the same experiment append as blank-line-separated blocks). Each tick moves to the current value, waits a settle delay (scaled by how far the actuator travelled), reads sensors, logs a row, then steps toward `end`. A sweep stops at `end` and resets to `start` — it never reverses or loops — and stops on unexpected disconnect.

**Logging shapes.** Each experiment logs in exactly one way:

- *Sweep-driven* (Lift Coefficient, Stem Racing): one row per sweep tick.
- *Continuous* (Sensors vs Time): one row per sensor-sample tick while logging is active.
- *Manual* (the rest): one point per **Log Point** click; the driven value (fan speed, angle or tapping channel) auto-advances for the next click.

Values are the controller's raw floats; drag shape and tapping channel are metadata only and never enter a calculation.

**Admin and safety.** Calibration writes and all firmware actions are checked in the main process (`admin.isUnlocked()`; calibration additionally requires no running sweep), not just in the UI. Calibration writes read the value back from the controller and only report `acknowledged: true` when the hardware confirms it.

**Safe state on connect and quit.** Whenever the app (re)connects and has verified the API version, and again before the app quits, it sends fan speed `0` and zero-motor to the controller so nothing left running from an earlier session or experiment continues. Both commands go through the normal command queue, so they use the encoding of the verified API version (JSON for V2.0.6). On quit, running sweeps are stopped first and the exit waits at most 5 s for the controller. Failures are logged and counted but never block startup or exit; in simulation only local state is reset.

**Firmware update.** Done over USB HID against the controller's bootloader (64-byte reports, SOH/EOT/DLE framing, CRC-16, Intel-HEX): connect → read info → erase → program (10 records per exchange) → CRC verify → run application. The bootloader's USB PID is **not yet hardware-confirmed**, so the operator enters VID/PID in Admin → Communication Settings. VID/PID are entered in hexadecimal, with or without a `0x` prefix (`12BF`, `0xF010`); if they are missing, the error lists the USB HID PIDs currently present under that VID. **Trigger Bootloader** stops the fan and sends `{"BL":1}` over the application serial link (the same command Process Control V2 uses; no reply is expected), after which Connect waits for the HID bootloader to enumerate. That command is **not yet verified on Wind Tunnel V2.0.6 hardware**; if the controller ignores it, enter bootloader mode from its touchscreen "Bootloader" menu instead. Hex files are chosen through a main-process file dialog (`bootloaderPickHex`) because Electron 32+ no longer exposes `File.path`. A file that is not an approved Wind Tunnel firmware image is rejected before it is opened, and a rejected pick never replaces a hex file that is already loaded. See `CLAUDE.md` for the full details and known caveats.

## Ethernet and remote access

The V2.0.7 controller serves its JSON API over a **WebSocket** on port `1245` (one text message per request and reply). The IP address, port and a **DHCP** flag are stored on the controller; DHCP is on by default and the address it obtains is shown only on the controller's touchscreen Settings page. The controller accepts **one Ethernet client at a time** and has no notion of users or permissions, so everything below is enforced by this app.

**Who is master.** USB is always the master link. With no USB controller, the first app to connect over Ethernet is the master. Only the master talks to the controller; everyone else connects to the master.

| Situation | What happens |
|---|---|
| USB controller present | The app uses USB. Ethernet is only a fallback. |
| No USB, Ethernet enabled | The app connects to the saved controller address over Ethernet and becomes the master (full control, sweeps, logging, calibration). |
| Ethernet master on one PC, USB plugged into another | The Ethernet PC releases the controller within a couple of seconds and shows who has it; it reconnects by itself when the USB master goes away. |
| Another device wants to watch or control | It connects to the master's relay (another copy of the app, or a browser page), not to the controller. |

**Setting it up (Admin > Network).**

1. *Controller Network Settings*: DHCP on/off, static IP and port, then **Send To Controller** (needs a connected controller, Admin unlocked and no sweep running). The controller sends no reply to this command, so it is reported as *sent*, not acknowledged; the IP cannot be read back.
2. *Connect To Controller Over Ethernet*: tick the option, enter the controller's address and port (default `1245`) or use **Scan Network** (finds controllers on this PC's local /24 subnets) and press **Save**. Use a switch/router with DHCP, or give the controller a static IP in the PC's subnet first.
3. *Remote Access (this PC is the master)*: choose who may connect — **Not connect**, **View live data only**, or **View and control** — set the port (default `8090`) and Save. An **access code** (`XXXX-XXXX`) is generated; **New code** replaces it and disconnects everyone. The browser address (`http://<this PC>:8090`) is shown. Connected devices are listed with their command counts.
4. *Connect To A Master PC*: on another PC, pick a master from **Masters found on this network** (or type its address), enter the access code and press **Connect**. This app then mirrors the master and stops using its own USB/Ethernet link; **Disconnect** returns to local scanning. The code is not saved, so it is asked for again each session.

**What remote devices can do.** *View only*: live lift, drag, pressure, air speed, fan and angle. *View and control*: additionally fan speed, motor angle, zero sensors, zero motor, LED settings and **Stop sweep**. Fan/angle/zero-motor are refused while a sweep is running on the master. Sweeps, CSV logging, calibration, firmware and Admin always stay on the master PC; CSV files are written to the master's Logs folder. The mode is checked by the master on every command, so switching to *view only* takes effect on devices that are already connected.

**Browser page.** The master serves a small page (`renderer/remote/`) so a tablet or phone can connect with just a browser: enter the access code, then watch (and, if allowed, control) the tunnel.

**Security.** Access needs the code; 5 wrong tries lock that address out for a minute; at most 8 devices and 20 commands per second per device. Traffic is **not encrypted** and the controller's own port has no authentication, so use this on a trusted network or a VPN, and never forward port `1245` to the internet. Anything that connects straight to the controller's port bypasses the view/control rule.

**Hardware behaviour worth knowing** (verified on a real controller):

- If a client disappears **without a proper WebSocket close** (process killed, Ctrl-C), the controller refuses all new connections (`ECONNREFUSED`) for about 23 seconds. The app always closes politely (including on quit), and keeps retrying, so after a crash the connection returns by itself. Quit with the window's close button, not Ctrl-C.
- Masters announce themselves with a UDP broadcast (port `8091`, no secrets), so discovery only works on the same subnet; across a VPN enter the master's address by hand. Windows Firewall may ask to allow the app on private networks the first time.
- If the master loses its link, the controller keeps its last fan speed; remote devices cannot stop it from afar.

## Experiments

| id | Title | Logging | CSV columns |
|---|---|---|---|
| `pressureToVelocity` | Convert Pressure to Velocity | manual | time, fanSpeed, pressure, velocity |
| `pressureTappedCylinder` | Pressure Tapped Cylinder | manual | time, fanSpeed, angle, pressure |
| `pressureTappedAerofoil` | Pressure Tapped Aerofoil | manual | time, fanSpeed, aerofoilAngle, tappingChannel, pressure |
| `liftCoefficient` | Lift Coefficient | angle sweep | time, angle, lift, drag |
| `dragCoefficient` | Drag Coefficient | manual | time, fanSpeed, drag, dragShape |
| `stemRacing` | Stem Racing | fan sweep | time, fanSpeed, lift, drag |
| `sensorsVsTime` | Sensors vs Time | continuous | time, fanSpeed, lift, drag, pressure |
| `custom` | Custom | manual | time, customX, customY |

Sweep defaults: angle `-20 → 45°` step `5°`, fan `0 → 60 %` step `10`, delay `5000 ms` (minimum `100 ms`). Drag shapes: Flat Surface, Cone, Tear Drop, Rough Ball, Semi Sphere, Smooth Ball. Tapping channels run `1–23` and wrap `23 → 1`.

## API reference

### Renderer API (`window.windTunnel`)

Exposed by `preload.js`. All methods return a Promise (the `on*` listeners register callbacks instead).

**Device**

| Method | IPC channel | Description |
|---|---|---|
| `getState()` | `device:getState` | Current [state object](#state-object). |
| `listPorts()` | `device:listPorts` | Available serial ports. |
| `connectPort(port, baudRate = 115200)` | `device:connectPort` | Connect and verify API version `2`. |
| `disconnect()` | `device:disconnect` | Close the port without auto-reconnect. |
| `setFanSpeed(value)` | `device:setFanSpeed` | Fan percent, clamped `0–100`. |
| `setAngle(value)` | `device:setAngle` | Motor angle, clamped `-180…180`. |
| `setLeds({ animMode, animColor, ambMode, ambColor })` | `device:setLeds` | Animation mode `0–4`, ambient mode `0–3`, colours `{r,g,b}` `0–255`. |
| `zeroSensors()` | `device:zeroSensors` | Zero the Wheatstone-bridge sensors. |
| `zeroMotor()` | `device:zeroMotor` | Zero the motor angle. |
| `sendCommand(command, payload[])` | `device:sendCommand` | Raw binary command (diagnostics). |
| `getDiagnostics()` | `device:getDiagnostics` | `{ tx, rx, retries, errors }`. |

**Experiments**

| Method | IPC channel | Description |
|---|---|---|
| `listExperiments()` | `experiment:list` | `{ experiments, dragShapes }`. |
| `selectExperiment(id)` | `experiment:select` | Select an experiment; ends the open log if it belongs to a different one and resets tapping/aerofoil/angle-increment. |
| `setTapping(channel)` | `experiment:setTapping` | Tapping channel `1–23`. |
| `setAerofoilAngle(value)` | `experiment:setAerofoilAngle` | Aerofoil angle of attack, `-45…45`. |
| `setManualAngleIncrement(inc)` | `experiment:setManualAngleIncrement` | Cylinder increment, `0–45`. |
| `setFanSpeedIncrement(inc)` | `experiment:setFanSpeedIncrement` | Fan increment per logged point, `0–25` (wraps `100 → 0`). |
| `setStemRacingChartType(type)` | `experiment:setStemRacingChartType` | `0` vs Time, `1` vs Air Speed, `2` vs Fan Speed (display label only). |
| `setCustomAxes(xField, yField)` | `experiment:setCustomAxes` | Axes for the Custom experiment. |
| `setDragShape(shape)` | `experiment:setDragShape` | One of the drag shapes. |
| `logPoint()` | `experiment:logPoint` | Capture one point for a manual experiment → `{ ok, row }`. |

**Sweeps**

| Method | IPC channel | Description |
|---|---|---|
| `startAngleSweep({ start, end, step, delay })` | `sweep:startAngle` | Returns `{ ok, sweep }`, or `{ ok: false, canceled: true }` if the save dialog is cancelled. |
| `startFanSweep({ start, end, step, delay })` | `sweep:startFan` | As above, driving fan speed. |
| `stopSweep()` | `sweep:stop` | Stop and reset to `start`. |
| `getSweepStatus()` | `sweep:status` | `state.sweep`. |

**Logging**

| Method | IPC channel | Description |
|---|---|---|
| `startLog()` | `log:start` | Opens a save dialog, then starts a CSV for the selected experiment. |
| `stopLog()` | `log:stop` | Closes the file → `{ ok, rowCount, path }`. |
| `getLogStatus()` | `log:status` | `{ active, path, rowCount, experimentId, logsFolder }`. |
| `setLogFolder(folder)` | `log:setFolder` | Persist the default Logs folder. |

**Calibration** (Admin unlocked and no running sweep required for writes)

| Method | IPC channel | Description |
|---|---|---|
| `getScalers()` | `calibration:getScalers` | `{ lift, drag, pressure }`. |
| `setScaler(channel, mode, value)` | `calibration:setScaler` | Channel `0` lift, `1` drag, `2` pressure; mode `0` absolute, `1` relative. Value is the typed factor (Absolute replaces the scaler, Relative multiplies it). Returns `{ ok, acknowledged, message, oldValue, newValue }` after read-back. |
| `getLut()` | `calibration:getLut` | Ten velocities (fan 10 %…100 %). |
| `setLutTable(velocities)` | `calibration:setLutTable` | Array of 10 velocities in m/s (fan 10 %…100 %, each 0–100). Writes all ten entries, then does ONE read-back; `acknowledged` is true only when every entry reads back within 0.011 m/s. |
| `setLutFan(percent)` | `calibration:setLutFan` | Fan step (0–100) for the pressure capture. Admin-gated except for 0 % (stop). |
| `calibrateDisplay()` | `calibration:calibrateDisplay` | Run touchscreen calibration. |
| `setNetwork(ip0, ip1, ip2, ip3, port, dhcp)` | `calibration:setNetwork` | Store IP, port and the DHCP flag on the controller (V2.0.7). The controller sends no reply, so the result is `{ ok, acknowledged: false, sent: true, message }`. |

**Admin and firmware**

| Method | IPC channel | Description |
|---|---|---|
| `adminStatus()` | `admin:status` | `{ configured, unlocked, secureStorage }`. |
| `setupAdmin(password)` | `admin:setup` | First-time password (min. 8 characters); unlocks. |
| `verifyAdmin(password)` | `admin:verify` | Unlock for 10 minutes → `{ ok }` or `{ ok: false, needsSetup: true }`. |
| `lockAdmin()` | `admin:lock` | End the session. |
| `getAuditLog()` | `admin:getAuditLog` | Last 50 audit entries. |
| `requestElevation()` | `admin:requestElevation` | Stub — always declines (UAC elevation not wired up yet). |
| `getFirmwareInfo()` | `admin:firmwareInfo` | `{ version }` of the approved firmware. |
| `bootloaderPickHex()` | `admin:bootloaderPickHex` | Native file dialog; returns the chosen path or `null`. |
| `bootloaderTrigger()` | `admin:bootloaderTrigger` | Stop the fan and send `{"BL":1}` to the connected controller. Refused in simulation, when disconnected and during a sweep. |
| `bootloaderCheckDevice(vid, pid)` | `admin:bootloaderCheckDevice` | `{ ok, present }`. VID/PID are hex strings (`0x` optional). |
| `bootloaderConnect(vid, pid)` | `admin:bootloaderConnect` | Open the bootloader HID session. |
| `bootloaderDisconnect()` | `admin:bootloaderDisconnect` | Close it. |
| `bootloaderLoadHex(path)` | `admin:bootloaderLoadHex` | Parse an Intel-HEX file; `{ ok: false, reason: 'rejected' }` if it is not an approved Wind Tunnel firmware image. |
| `bootloaderReadInfo()` | `admin:bootloaderReadInfo` | Bootloader version. |
| `bootloaderErase()` | `admin:bootloaderErase` | Erase application flash. |
| `bootloaderProgram()` | `admin:bootloaderProgram` | Program the loaded hex. |
| `bootloaderReadCrc()` | `admin:bootloaderReadCrc` | Verify device CRC against the hex. |
| `bootloaderJumpToApp()` | `admin:bootloaderJumpToApp` | Run the application. |

Every firmware call returns `{ ok, stage, message, … }`; a locked Admin session yields `{ ok: false, reason: 'admin-locked' }`.

**Network (Admin only; a locked session returns `{ ok: false, message: 'Admin session is locked.' }`)**

| Method | IPC channel | Description |
|---|---|---|
| `getNetworkSettings()` | `network:getSettings` | `{ ethernet { enabled, host, port }, relay { mode, port, accessCode }, remote { host, port }, addresses, relayRunning }`. |
| `saveEthernetSettings({ enabled, host, port })` | `network:saveEthernet` | Save the controller's Ethernet address (used only when no USB controller is present). |
| `saveRelaySettings({ mode, port })` | `network:saveRelay` | `mode` is `off`, `view` or `control`. Restarts the relay if the port changed; applies to connected devices immediately. |
| `regenerateAccessCode()` | `network:regenerateCode` | New access code; disconnects all remote devices. |
| `scanNetwork(port)` | `network:scan` | Probe this PC's /24 subnets for controllers → `{ devices: [{ host, port, apiVersion }] }`. |
| `connectRemote(host, port, code)` | `network:connectRemote` | Become a remote client of another PC's relay. |
| `disconnectRemote()` | `network:disconnectRemote` | Leave remote mode and resume local scanning. |

`disconnect()` also ends a remote session. In remote mode `setFanSpeed`, `setAngle`, `setLeds`, `zeroSensors`, `zeroMotor` and `stopSweep` are forwarded to the master; sweeps, logging and calibration return a refusal.

### Push events

Register with these listeners; each is pushed from the main process.

| Listener | Channel | Payload |
|---|---|---|
| `onState(cb)` | `state:update` | The full [state object](#state-object). |
| `onAuditUpdate(cb)` | `audit:update` | Last 50 audit entries. |
| `onLogEvent(cb)` | `log:event` | `{ rowCount, path }` after each CSV row. |
| `onFirmwareProgress(cb)` | `firmware:progress` | `{ stage, level: 'info'\|'warn'\|'error', message }`. |

### State object

Key fields of `state` (see `main/state.js`): `connected`, `simulation`, `port`, `apiVersion`, `fanSpeed`, `angle`, `sensors { lift, drag, pressure, velocity }`, `diagnostics { tx, rx, retries, errors }`, `experimentId`, `tapping { channel, increment }`, `aerofoilAngle`, `manualAngle { increment }`, `dragShape`, `fanSpeedIncrement`, `stemRacingChartType`, `customAxes { x, y }`, `leds`, `sweep { type, running, start, end, step, delay, current }`, `sensorSampleSeq` (bumps on each genuinely new reading), `loggedPointSeq` / `lastLoggedPoint` (bump on each Log Point), `logging { active, path, rowCount, experimentId }`, `adminUnlocked`. Network fields: `transport` (`'usb'` / `'ethernet'` / `'remote'` / `null`), `remoteAccess` (`'view'` / `'control'` when this app is a remote client), and `network { relay { running, mode, port, clients[] }, remote { connected, host, hardwareTransport }, discovered[], ethernetYield }`.

### Controller serial protocol

USB serial, `115200` baud. Request frame: `':' + command byte + payload + ';' + '\n'`. The response echoes the command byte. Fixed-length payloads are sliced by length because raw float bytes can contain the terminator.

| Cmd | TX payload | Operation | RX data |
|---|---|---|---|
| `A` | – | Read API version | 1 byte (must be `2`) |
| `B` | 1 byte | Set fan speed `0–100` | ack |
| `C` | – | Read sensors | 4 × float32 LE: lift, drag, pressure, velocity |
| `D` | int16 LE | Set motor angle | ack |
| `E` | 9 bytes | Set LEDs | ack |
| `F` | – | Zero sensors | ack |
| `G` | – | Zero motor | ack |
| `H` | channel, float32, mode | Set sensor scaler | ack |
| `I` | – | Read scalers | 3 × float32 |
| `J` | index, float32 | Set LUT entry | ack |
| `K` | – | Read LUT | 10 × float32 |
| `L` | – | Calibrate display | ack |
| `M` | 4 IP bytes, uint16 LE port, DHCP flag byte | Store network address (V2.0.7 JSON: `ip0`–`ip3`, `port`, `dhcp`) | none |

The app sends the JSON form of these commands (the V2.0.7 firmware no longer parses the binary frames), as one text message per request when connected over Ethernet. The command set is defined by the firmware and must not be extended from this app.

## Files written by the app

Under Electron's `userData` folder: `wind-tunnel-admin.json` (scrypt hash + salt, never the plaintext password) and `wind-tunnel-config.json` (Logs folder, Ethernet target, remote-access mode/port and the remote-access **access code**, stored in plain text in a file readable only by the current user). CSV logs default to `Documents\Wind Tunnel\Logs`. Theme preference lives in `localStorage['wind-tunnel-theme']`.

## Safety and Git boundary

Do not modify or reflash firmware during normal UI development. Firmware flashing and calibration writes are Admin-gated and need explicit confirmation. The bootstrap password must never be committed, embedded or logged. The bootloader's USB PID is not yet hardware-confirmed — see `CLAUDE.md` before relying on firmware updates.

This directory is an independent Git repository. Commit and push from here only; the sibling `Firmware`, `Matrix Wind Tunnel 2.2` and `Process Control V2` directories are read-only references. See `CLAUDE.md` for the full module layout, dependency graph and protocol/calibration/bootloader notes.

## Release notes

### Unreleased

- New: **Ethernet** support for the V2.0.7 controller (WebSocket on port `1245`). With no USB controller the app connects over Ethernet using the address saved in Admin > Network; USB is always preferred and takes over automatically when it appears. Verified on a real controller: the WebSocket API answers as documented, and clients must close properly (an abrupt disconnect blocks new connections for ~23 s).
- New: **Remote access.** The PC that owns the controller (USB, or Ethernet when there is no USB) can host a relay so other PCs, tablets and phones can watch, or also control, the tunnel. Admin chooses *off*, *view only* or *view and control*; access needs a code; sweeps, logging, calibration, firmware and Admin stay on the master. A browser page is served for tablets/phones; the app can also connect to another PC as a remote client.
- New: masters announce themselves on the LAN and are listed in Admin > Network; an app holding the controller over Ethernet steps aside for a USB master.
- New: Admin > Network tab. The network card moved there from the Calibrator tab and gained the DHCP option and the V2.0.7 default port `1245`. The IP/port/DHCP command is reported as *sent* rather than *acknowledged* because the controller does not reply.
- Change: the app now depends on `ws`; fan/angle/LED/zero commands live in `main/control.js`.
- API: added `getNetworkSettings`, `saveEthernetSettings`, `saveRelaySettings`, `regenerateAccessCode`, `scanNetwork`, `connectRemote`, `disconnectRemote`; `setNetwork` takes a `dhcp` argument. The state object gained `transport`, `remoteAccess` and `network`.
- New: Admin > Bootloader "Trigger Bootloader" is enabled and sends `{"BL":1}` to the connected controller (same command Process Control V2 uses) after stopping the fan, then Connect opens the USB HID bootloader. Unverified on Wind Tunnel V2.0.6 hardware; the touchscreen "Bootloader" entry remains the fallback.
- Fix: bootloader VID/PID fields accept hexadecimal with or without `0x` (`F010`, `0x12BF`); previously un-prefixed hex was rejected. When an ID is missing, the message lists the USB HID PIDs currently present under that VID.
- Fix: bootloader device detection (`HID.devices()`) now works; the `node-hid` module was being destructured so only the device class was available.
- Change: firmware files that are not approved Wind Tunnel images are rejected at load time (before the file is opened), and a rejected pick no longer updates the displayed hex path. This replaces the earlier warning-only check.
- Change: the Admin > Bootloader "Approved Image" label is removed; `getFirmwareInfo()` now returns `{ version }` only.
- API: added `bootloaderTrigger`.

### v0.1.7

- New: Admin > Calibrator > Sensor Scalers now shows the **live lift (mN), drag (mN) and pressure (Pa) sensor readings** beside each scaler, so a scaler can be changed and judged against the sensor on one screen. Shows `-` while disconnected or before the first reading.

### v0.1.6

- Fix: Admin > Sensor Scalers (lift / drag / pressure, Absolute / Relative) now behaves like the legacy calibrator. The scale factor is sent as a 6-decimal number (not a widened float32 such as `0.7549999952316284`) and read-backs are shown to 6 decimals.
- Fix: empty, non-numeric, `0x10`-style, zero, out-of-range or wrong channel/mode input is rejected instead of being written to the controller as a silent `0` / Absolute / Lift.
- Fix: a scaler is only reported as saved when the controller reports the value the firmware rule predicts (Absolute: `Scaler = factor`; Relative: `Scaler = factor * Scaler`). The old value is read first, the write is followed by a 100 ms EEPROM settle, and the message shows old -> new. A Relative factor that would drive the stored scaler to 0 or out of range is refused.
- Fix: the mode drop-down returns to Absolute after a save or Refresh (the field then holds an absolute value, so a second Save used to apply a Relative factor twice); Save/Refresh are disabled while a write is in progress.
- Change: scalers also work in `--simulate`. The velocity lookup table is unchanged.
- Connection: transport rewritten for the V2.0.6 JSON firmware with a link watchdog (drops within 8 s of silence, immediate on unplug), VID/PID rescan so a controller that returns on another COM number is found, and queued commands never replay onto a new session.
- Sweeps: starting a sweep while disconnected is refused, and disconnecting stops any running sweep; fan is switched off immediately on quit.
- CSV logs: the header row now shows names with units (for example `Lift (mN)`, `Angle (deg)`).
- API: `setScaler` returns `{ ok, acknowledged, message, oldValue, newValue }`; it accepts the raw field text as `value`.

### v0.1.5

- Fix: Admin → Velocity Lookup Table no longer reverts typed values to stale numbers or shows blank entries for 60–100 %. The controller answers `getvlu` as two JSON objects (`vl0`–`vl4`, then `vl5`–`vl9`); the app now merges both, and no longer reads the table straight back after each single-entry write.
- Change: one **Save Table** button writes all ten entries and verifies them with a single read-back; typed values are kept if the controller does not confirm.
- New: the velocity LUT is built from pressure. **Zero Sensor** zeroes the sensors, **Start capture** runs the fan at 10 %, and typing the pressure (Pa) for a step and pressing **Enter** converts it to air speed with V = √(2·|ΔP| / ρ), ρ = 1.20 kg/m³ (CP0704 Worksheet 1) and moves the fan to the next 10 % (Enter after 100 % stops the fan); velocity can still be typed directly.
- API: removed `setLutEntry`; added `setLutTable`, `setLutFan`.

### v0.1.4

- Fix: Admin > Bootloader "Load Hex File" now works (native file dialog; Electron 32+ no longer provides `File.path`, so hex files could never be loaded before).
- The approved firmware image name is derived from one version constant (`WindTunnel V<x.y.z>.hex`); a warning is logged if a different hex file is loaded.
- The PID warning banner only shows while the bootloader PID field is empty. Trigger Bootloader remains disabled: the approved firmware has no remote command for it (use the touchscreen).

### v0.1.3

- **In-app updates:** the Admin > Updates "Check For Updates" button now works (electron-updater via GitHub releases): check, "download?" prompt with progress, then "Restart Now" prompt. Updates only work in the installed app, not from source. Note: v0.1.1/v0.1.2 installs have the old non-functional button, so install v0.1.3 manually once.
- Fix: velocity LUT inputs no longer log "NaN cannot be parsed" console warnings when the controller returns NaN entries (shown blank).

### v0.1.2

- **Safe state:** fan speed set to `0` and motor zeroed after every successful connect/reconnect and before the app quits (sweeps stopped first, 5 s cap).
- Lockfile version synced with `package.json`.

### v0.1.1

- Fix: `main/` modules are now included in the packaged app.

### v0.1.0

- First release: Control + Calibrator, 8 experiments, CSV logging, Admin-gated calibration and bootloader firmware update; Windows, macOS and Linux builds.
