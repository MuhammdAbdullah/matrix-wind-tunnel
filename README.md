# Wind Tunnel

Windows Electron desktop application for the Matrix Wind Tunnel. It combines the former **Wind Tunnel Control** and **Wind Tunnel Calibrator** tools in one app: live sensor readout, fan and angle control, the 8-experiment suite with angle/fan sweeps and CSV logging, scaler/velocity-LUT calibration, and Admin-gated firmware (bootloader) updates.

## Contents

- [What the app does](#what-the-app-does)
- [Getting started](#getting-started)
- [How it works](#how-it-works)
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
| **Connection** | Scans for the controller (USB VID `0x12BF`, PID `0xF010`), connects at `115200` baud, verifies API version `2`, and reconnects automatically after unplug/replug or read failures. |
| **Control** | Live lift (mN), drag (mN), pressure (Pa) and air velocity (m/s); fan speed `0–100 %`; motor angle `-180°…180°`; zero sensors; zero motor; LED animation/ambient settings. |
| **Experiments** | Eight experiments (pressure-to-velocity, pressure-tapped cylinder/aerofoil, lift, drag, stem racing, sensors vs time, custom X/Y), each with its own traces, axes and CSV columns. A live chart and an experiment-history chart are kept separate. |
| **Sweeps** | Timed angle sweeps and fan-speed sweeps that move the actuator, wait for it to settle, read the sensors, log a point and advance. |
| **Logging** | CSV files (`WindTunnelLog_<timestamp>.csv` style) in a configurable folder; the save location is asked once per experiment. |
| **Admin** | Password-gated area (10-minute session) with diagnostics (raw TX/RX, retry/error counters, activity log), sensor scalers, 10-point velocity LUT, display calibration, network IP/port, HID bootloader firmware update, app-update status and an audit trail. |
| **Simulation** | `--simulate` replaces the hardware with synthetic sensor data for development without a tunnel. |

## Getting started

Requirements: Windows, Node.js, and (for real hardware) the Wind Tunnel controller on USB.

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
└────────────────┬───────────────────────────────────────────────────────────┘
                 │ USB serial 115200 baud            USB HID (bootloader mode)
            Wind Tunnel controller (firmware V2.0.6)
```

**Process boundary.** The renderer never touches serial, HID or the filesystem. It only calls `window.windTunnel.*`, which maps 1:1 to `ipcMain.handle` channels in `main.js`.

**One source of truth.** `main/state.js` holds one `state` object. Every change calls `publish()`, which pushes the whole object to the renderer on `state:update`; the renderer re-derives all gauges, labels and charts from each snapshot.

**Connection.** `serial.startAutoConnect()` polls `SerialPort.list()` every 2 s while disconnected. After connecting, the API version is read (`A`) and must equal `2`, otherwise the port is closed. A 1 s monitor plus consecutive failed sensor reads trigger reconnect with exponential back-off (`min(1000·2ⁿ, 8000)` ms). Intentional disconnects do not reconnect.

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

**Firmware update.** Done over USB HID against the controller's bootloader (64-byte reports, SOH/EOT/DLE framing, CRC-16, Intel-HEX): connect → read info → erase → program (10 records per exchange) → CRC verify → run application. The bootloader's USB PID is **not yet hardware-confirmed**, so the operator enters VID/PID in Admin → Communication Settings. The controller must be put into bootloader mode on its touchscreen; the app cannot trigger it. See `CLAUDE.md` for the full details and known caveats.

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
| `setScaler(channel, mode, value)` | `calibration:setScaler` | Channel `0` lift, `1` drag, `2` pressure; mode `0` absolute, `1` relative. Returns `{ ok, acknowledged, message, newValue }` after read-back. |
| `getLut()` | `calibration:getLut` | Ten velocities (fan 10 %…100 %). |
| `setLutEntry(index, velocity)` | `calibration:setLutEntry` | Index `0–9`, velocity in m/s, with read-back. |
| `calibrateDisplay()` | `calibration:calibrateDisplay` | Run touchscreen calibration. |
| `setNetwork(ip0, ip1, ip2, ip3, port)` | `calibration:setNetwork` | Store IP and port on the controller. |

**Admin and firmware**

| Method | IPC channel | Description |
|---|---|---|
| `adminStatus()` | `admin:status` | `{ configured, unlocked, secureStorage }`. |
| `setupAdmin(password)` | `admin:setup` | First-time password (min. 8 characters); unlocks. |
| `verifyAdmin(password)` | `admin:verify` | Unlock for 10 minutes → `{ ok }` or `{ ok: false, needsSetup: true }`. |
| `lockAdmin()` | `admin:lock` | End the session. |
| `getAuditLog()` | `admin:getAuditLog` | Last 50 audit entries. |
| `requestElevation()` | `admin:requestElevation` | Stub — always declines (UAC elevation not wired up yet). |
| `bootloaderCheckDevice(vid, pid)` | `admin:bootloaderCheckDevice` | `{ ok, present }`. |
| `bootloaderConnect(vid, pid)` | `admin:bootloaderConnect` | Open the bootloader HID session. |
| `bootloaderDisconnect()` | `admin:bootloaderDisconnect` | Close it. |
| `bootloaderLoadHex(path)` | `admin:bootloaderLoadHex` | Parse an Intel-HEX file. |
| `bootloaderReadInfo()` | `admin:bootloaderReadInfo` | Bootloader version. |
| `bootloaderErase()` | `admin:bootloaderErase` | Erase application flash. |
| `bootloaderProgram()` | `admin:bootloaderProgram` | Program the loaded hex. |
| `bootloaderReadCrc()` | `admin:bootloaderReadCrc` | Verify device CRC against the hex. |
| `bootloaderJumpToApp()` | `admin:bootloaderJumpToApp` | Run the application. |

Every firmware call returns `{ ok, stage, message, … }`; a locked Admin session yields `{ ok: false, reason: 'admin-locked' }`.

### Push events

Register with these listeners; each is pushed from the main process.

| Listener | Channel | Payload |
|---|---|---|
| `onState(cb)` | `state:update` | The full [state object](#state-object). |
| `onAuditUpdate(cb)` | `audit:update` | Last 50 audit entries. |
| `onLogEvent(cb)` | `log:event` | `{ rowCount, path }` after each CSV row. |
| `onFirmwareProgress(cb)` | `firmware:progress` | `{ stage, level: 'info'\|'warn'\|'error', message }`. |

### State object

Key fields of `state` (see `main/state.js`): `connected`, `simulation`, `port`, `apiVersion`, `fanSpeed`, `angle`, `sensors { lift, drag, pressure, velocity }`, `diagnostics { tx, rx, retries, errors }`, `experimentId`, `tapping { channel, increment }`, `aerofoilAngle`, `manualAngle { increment }`, `dragShape`, `fanSpeedIncrement`, `stemRacingChartType`, `customAxes { x, y }`, `leds`, `sweep { type, running, start, end, step, delay, current }`, `sensorSampleSeq` (bumps on each genuinely new reading), `loggedPointSeq` / `lastLoggedPoint` (bump on each Log Point), `logging { active, path, rowCount, experimentId }`, `adminUnlocked`.

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
| `M` | 4 IP bytes, uint16 LE port | Store network address | ack |

The command set is defined by the approved firmware (`WindTunnel V2.0.6`) and must not be extended from this app.

## Files written by the app

Under Electron's `userData` folder: `wind-tunnel-admin.json` (scrypt hash + salt, never the plaintext password) and `wind-tunnel-config.json` (Logs folder). CSV logs default to `Documents\Wind Tunnel\Logs`. Theme preference lives in `localStorage['wind-tunnel-theme']`.

## Safety and Git boundary

Do not modify or reflash firmware during normal UI development. Firmware flashing and calibration writes are Admin-gated and need explicit confirmation. The bootstrap password must never be committed, embedded or logged. The bootloader's USB PID is not yet hardware-confirmed — see `CLAUDE.md` before relying on firmware updates.

This directory is an independent Git repository. Commit and push from here only; the sibling `Firmware`, `Matrix Wind Tunnel 2.2` and `Process Control V2` directories are read-only references. See `CLAUDE.md` for the full module layout, dependency graph and protocol/calibration/bootloader notes.

## Release notes

### v0.1.2

- **Safe state:** fan speed set to `0` and motor zeroed after every successful connect/reconnect and before the app quits (sweeps stopped first, 5 s cap).
- Lockfile version synced with `package.json`.

### v0.1.1

- Fix: `main/` modules are now included in the packaged app.

### v0.1.0

- First release: Control + Calibrator, 8 experiments, CSV logging, Admin-gated calibration and bootloader firmware update; Windows, macOS and Linux builds.
