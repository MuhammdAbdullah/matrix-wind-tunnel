# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Scope and git boundary

This directory is its own independent Git repository (`matrix-wind-tunnel`) — the new Windows Electron app combining **Wind Tunnel Control** and **Wind Tunnel Calibrator**. Commit and push only from here. **All code changes belong in this folder only.** The sibling folders one level up (`Firmware/`, `Matrix Wind Tunnel 2.2/`, `Process Control V2/`) are **read-only reference material** — never edit, add, or remove files inside them, and they are never part of this repo's commits. See `../AGENTS.md` for the full behavioral spec those references define (protocol tables, experiment/graph rules, Admin requirements, firmware constraints). Read that file before implementing any protocol, calibration, or experiment behavior; this CLAUDE.md only covers what's inside this repo.

Never modify the approved firmware. The approved image is `Firmware/WindTunnel V2.0.6.hex` (outside this repo).

## Commands

```powershell
npm install
npm start            # Electron desktop app — auto-scans for real USB hardware
npm run simulate      # Electron with --simulate flag (synthetic sensor data, no hardware needed)
npm run dev           # Electron with --dev flag
npm run build-win     # electron-builder Windows NSIS installer -> dist/
```

There is no automated test suite and no lint config. Verify changes by running `npm run simulate` (no hardware) or `npm start` against a real controller, and by manual checks against `../AGENTS.md`'s protocol/behavior tables.

## Architecture

Main-process logic is split into `main/` modules, required from a slim orchestrating `main.js` (window creation + `ipcMain.handle` registration only). The renderer has no bundler/build step — `renderer/index.html` loads `charts.js` then `app.js` directly via `<script>` tags, plus Chart.js from a CDN.

```
main.js            Orchestration only: BrowserWindow, all ipcMain.handle wiring, app.whenReady bootstrap
main/
  protocol.js      Binary frame constants/encode/decode — frame(), parseFrames(), CMD byte map
  state.js         Shared mutable `state` object, publish()/pushEvent() (IPC push to renderer),
                   clamp(), simulateSensors(), the in-memory audit array
  serial.js        SerialPort transport: commandQueue/sendBinary, connectHardware, startAutoConnect,
                   connection monitoring + exponential-backoff reconnect, setFanSpeed/setAngle/
                   readSensorsOnce, an onUnexpectedDisconnect() listener registry
  admin.js         Password hash (scrypt + salt) storage, unlock/lock with a 10-minute session timeout
  experiments.js   The 8-experiment declarative table + drag-shape list + sweep defaults
  sweeps.js        Sensor-sample timer, angle/fan sweep timers, tapping auto-advance
  calibration.js   Scaler/LUT/display/network writes, gated on admin unlocked + sweep idle
  bootloader.js    HID bootloader transport + protocol (SOH/EOT/DLE framing, CRC-16,
                   Intel HEX parsing, erase/program/verify/run) -- see "Bootloader protocol"
  firmware.js      Thin orchestration over bootloader.js -- see "Bootloader protocol" below
  logging.js       CSV experiment logging to a configurable Logs folder
preload.js         contextBridge surface — exposes window.windTunnel.* (~40 methods) to the renderer only
renderer/
  index.html       Single-page shell: sidebar nav switches `.view` sections (control/calibrator/admin)
  app.js           All renderer state/rendering/event wiring — no framework, no module system
  charts.js         Chart.js setup — IIFE exposing WindTunnelCharts.{createCharts,configureForExperiment,updateLive,updateHistory}
  styles.css       Wind-Tunnel-specific overrides layered on top of the vendored matrix-ui.css
assets/css/matrix-ui.css   Vendored verbatim from `../Process Control V2/assets/css/matrix-ui.css`
                           (compiled Tailwind+DaisyUI bundle) — never hand-edit; if more utility
                           classes are needed, add a fallback rule in styles.css instead (this
                           bundle only contains classes Process Control V2 itself used, so new
                           Tailwind/DaisyUI class names used here may simply be absent from it —
                           verify with a grep against matrix-ui.css before relying on one)
```

**Process boundary**: `contextIsolation: true`, `nodeIntegration: false`. The renderer never touches `serialport` directly — it only calls `window.windTunnel.*` (defined in `preload.js`), which maps 1:1 to `ipcMain.handle` channels in `main.js`. When adding a new hardware/experiment/calibration/Admin operation, add it in four places: the logic in the relevant `main/*.js` module, an `ipcMain.handle` in `main.js`, a matching method in `preload.js`, and the call site in `renderer/app.js`.

**Module dependency direction** (no circular requires): `state.js` and `protocol.js` are leaves; `serial.js` depends on both; `logging.js` depends on `state.js`; `sweeps.js` depends on `serial.js` + `logging.js` + `experiments.js`; `calibration.js` depends on `serial.js` + `admin.js`; `bootloader.js` is a leaf (own HID transport, no dependency on `serial.js` -- the bootloader is a distinct USB HID identity/protocol from the running application's serial link); `firmware.js` depends on `bootloader.js` + `admin.js` + `state.js` (for `pushEvent`). Cross-module reactions (e.g. "stop the sweep on an unexpected disconnect") go through `serial.onUnexpectedDisconnect(listener)` rather than `serial.js` requiring `sweeps.js` back — keep new cross-cutting hooks in that direction (the dependent module registers a listener on the module it depends on, never the reverse).

### State and push updates

`main/state.js` holds one `state` object (connection status, simulation flag, fan/angle, sensors, diagnostics, `experimentId`, `tapping`, `dragShape`, `customAxes`, `sweep`, `logging`, `adminUnlocked`). Every mutation calls `publish()`, which recomputes `state.adminUnlocked` from `admin.isUnlocked()` and pushes the whole object to the renderer via the `state:update` IPC event. `pushEvent(channel, payload)` is the generic one-off push used by `logging.js` (`log:event`) and `firmware.js` (`firmware:progress`); `appendAudit()` also uses it for `audit:update`. The renderer has no independent source of truth — `render(value)` in `app.js` re-derives all DOM text/charts from each pushed snapshot. Renderer-only state (sample buffers for charting, which experiment object is selected, pending hex file path) is fine locally; don't duplicate anything `main/state.js` already tracks authoritatively.

### Serial transport, command queue, and reconnect

- USB identity: VID `0x12BF`, PID `0xF010`; baud `115200`. `serial.startAutoConnect()` polls `SerialPort.list()` every 2s while disconnected.
- Binary frame format: `':' + command byte + payload + ';\n'` (`main/protocol.js`'s `frame()`/`parseFrames()`). `parseFrames()` returns `{frames, remainder}` — the remainder buffer lives in `serial.js`'s module-local `serialBuffer`, not in `protocol.js`.
- `sendBinary(command, payload, {timeout, source})` chains onto a single `commandQueue` promise so only one command is ever in flight. **The chain is deliberately re-armed with `.catch(() => {})` after every attempt** — without that, one rejected/timed-out command would permanently wedge the queue (every later `.then()` on an already-rejected promise short-circuits without ever running). Don't remove that line. `source` (`'control'|'calibrator'|'system'`) is recorded in the audit log per command.
- `API_VERSION = 2` is verified right after every connect (`connectHardware()`, used by both the manual `device:connectPort` path and auto-connect/reconnect) — a mismatch closes the port and throws.
- Reconnect: `startConnectionMonitoring()` (1s interval) and `reportReadOutcome(false)` (called by the sensor-sample timer after N consecutive failed reads) both call `scheduleAutoReconnect()`, which backs off `min(1000 * 2^failures, 8000)` ms and retries `lastKnownPortPath`. A user-initiated `disconnect()` sets `intentionalClose` first so the port's `'close'` handler doesn't also trigger a reconnect. `sweeps.js` registers `serial.onUnexpectedDisconnect(() => stopSweep())` at module load — any new timer/loop that must die on disconnect should hook the same registry rather than polling `state.connected` itself.

### Simulation mode

`--simulate` (or `WIND_TUNNEL_SIMULATION=1`) makes `state.simulation = true` at startup. `serial.setFanSpeed`/`setAngle`/`readSensorsOnce` short-circuit to `state.simulateSensors()` (in `main/state.js`) instead of touching the real port, so sweeps and the sensor-sample timer work unchanged in simulation — they just never hit `sendBinary`. Production (`npm start` with no flag) must never silently fall into this mode.

### Experiments, sweeps, and logging

`main/experiments.js` is a single declarative table (8 entries) read by both `main.js`'s `experiment:list` handler and `main/sweeps.js`/`main/logging.js`. **`dragShape` and `tapping` are metadata only** — the Flowcode source they're derived from has no coefficient formula (no density/area/`0.5*v²` anywhere) and no per-shape correction factor, so "Lift/Drag Coefficient" experiments log the raw sensor float as-is. Never make a calculation read `state.dragShape` or `state.tapping` — they only belong in the CSV-row builder (`sweeps.js`'s `buildRow()`) and the UI label.

Each experiment is exactly one of three logging shapes, matching the legacy Flowcode source's own timer wiring and `OnLogButtonClick` switch (`Wind Tunnel Control.fcsx`):
- **Sweep-driven** (`sweepType: 'angle'|'fan'`: `liftCoefficient`, `stemRacing`) — one point/CSV row per sweep tick, from `sweeps.js`'s `tick()`.
- **Continuous** (`sensorsVsTime` only) — one point/CSV row per sensor-sample tick while `state.logging.active`, from `startSensorSampleTimer`. This is the *only* no-sweep experiment the legacy source auto-logs on a timer (its own timer 6 only calls `OnLogButtonClick` automatically when `Exercise = 6`).
- **Manual** (`manualLog: true`: `pressureToVelocity`, `pressureTappedCylinder`, `pressureTappedAerofoil`, `dragCoefficient`, `custom`) — one point per `sweeps.js`'s `logPoint()` call (IPC `experiment:logPoint`, fired by the renderer's "Log Point" button), mirroring the legacy source's single "Log" button: a chart point is always added, a CSV row only if a log file is open, and the driven value (fan speed / manual angle / tapping channel) auto-advances by its configured increment for the next click. Convert Pressure to Velocity shares the same `fanSpeedIncrement` field/variable as Drag Coefficient (`Wind Tunnel Control.fcsx:1528` and `:1722` both read the same `IncrementSpeed` variable), even though that property is filed under Drag Coefficient's property folder in the legacy source.

`sweeps.js` runs up to two independent timers (never more than one sweep at a time): the sensor-sample timer (`startSensorSampleTimer`, skips its own read while a sweep tick is active to avoid duplicate serial round-trips) and the active sweep timer (`startAngleSweep`/`startFanSweep`). A sweep **auto-stops at `end` and resets `current` to `start` — it never reverses or loops**; manual `stopSweep()` resets to `start` too, for consistency. Tapping channel auto-advances by `tapping.increment` after each logged point and wraps `23 -> 1`.

`logging.js` writes `WindTunnelLog_<timestamp>.csv` using the active experiment's `csvColumns` as the header, to a folder persisted in `wind-tunnel-config.json` (separate file from the admin credential). `appendRow()` is called from the sweep tick for sweep-driven experiments, from the sensor-sample timer for `sensorsVsTime`, and from `logPoint()` for the manual experiments.

### Admin / security

- Admin credential is a scrypt hash + random salt in `wind-tunnel-admin.json` under Electron's `userData` path (`main/admin.js`). Plaintext password is never persisted or logged. `admin.unlock()` sets a 10-minute expiry (`SESSION_TIMEOUT_MS`); `isUnlocked()` is checked lazily (no background timer) and is the **authoritative** gate for calibration writes — `main/calibration.js`'s `guard()` checks `admin.isUnlocked()` and `!state.sweep.running` server-side, not just in the renderer (the renderer's own checks are fast-path UX only, bypassing them must not be enough to write calibration).
- **Bootloader protocol** (`main/bootloader.js`, orchestrated by `main/firmware.js`): ported **verbatim** from `../Process Control V2/main.js`'s bootloader IPC handlers (its persistent-USB-HID-connection model, CRC table/algorithm, frame escaping, Intel-HEX handling, batching, and every timeout/retry value), at the owner's explicit request to bring the logic over "as it is" rather than fixing anything, including a latent bug described below. `main/bootloader.js` keeps the device handle open across calls (`connect()`/`disconnect()`) instead of opening/closing it per action — Control and Calibrator-style "one open session" rules don't apply here since the bootloader is a separate USB HID identity from the running application, but within a bootloader session the same open handle is reused by every subsequent action until the operator disconnects or `run()`/`JMP_TO_APP` succeeds (mirroring Process Control V2's `usbHidDevice` module-scope state). The protocol: 64-byte HID reports (report ID `0x00` + 64 data bytes); each command frame is `SOH(0x01) + [cmd byte + payload + CRC16LE] with SOH/EOT(0x04)/DLE(0x10) byte-stuffed + EOT`; commands are `READ_BOOT_INFO=1`, `ERASE_FLASH=2`, `PROGRAM_FLASH=3`, `READ_CRC=4`, `JMP_TO_APP=5`; the CRC is a CRC-16/XMODEM-style nibble-table checksum (`calculateBootloaderCRC` in Process Control V2, ported as `calculateCrc` in `bootloader.js`). `PROGRAM_FLASH` batches `RECORDS_PER_COMMAND = 10` raw Intel-HEX records per HID exchange, fire-and-forget (no response wait, no retry, matching Process Control V2 exactly) with a 2ms pause between batches; `READ_CRC`/`verify` sends a CRC/address/length computed locally from the loaded hex file (mirroring Process Control V2's `calculateFlashCRCFromHexFile`, which processes every line in the file, not just data records) and the device's returned CRC must match before `verify` reports success. Per-command timeouts/retries also match Process Control V2 exactly: `readInfo` 3 retries/200ms, `erase` 3 retries/5000ms, `readCrc` 3 retries/2000ms, `run`/`JMP_TO_APP` 1 attempt/10ms with no response required; connecting polls for the USB HID device up to 10 times, 500ms apart (it may still be enumerating right after a bootloader-mode trigger). `JMP_TO_APP` is fire-and-forget and closes the persistent connection afterward (the device disconnects itself once it jumps).
  - **Known, intentionally-unfixed bug carried over from Process Control V2**: `computeVerifyInfo()`'s virtual-flash scratch buffer (`FLASH_SIZE`) is exactly `5 * 1024 * 1024` bytes — smaller than `BOOT_SECTOR_BEGIN` (`0x7FC000`, ~8.37 MB). This is a latent buffer-overflow bug in the original C++ bootloader tool that Process Control V2's JS port reproduces, and the owner explicitly asked for this app to reproduce it too rather than fix it (do not re-enlarge this buffer). The write into that undersized buffer is a bounds-checked per-byte loop rather than `Buffer.copy()` purely so the host doesn't crash with a `RangeError` — bytes landing at or past `FLASH_SIZE` are silently dropped instead, which is the same *effective* behavior as the original bug (a wrong/short CRC for hex files whose data lands above 5 MB), not a fix of it.
  - The host-side ASCII-hex-to-binary conversion was written cleanly rather than replicating a latent CRLF-handling bug in the original tool's `ConvertAsciiToHex` (that bug could append a garbage trailing byte per record on CRLF-terminated hex files) — this only changes what the *host* parses from the file on disk, not anything about the wire protocol, and was already true before this port.
  - **The bootloader's USB PID is NOT confirmed.** The approved application firmware identifies as VID `0x12BF` / PID `0xF010` (documented in `../AGENTS.md`), but nothing in this codebase confirms the *bootloader* enumerates under the same PID — PIC32 USB bootloaders commonly use a different PID than the running application (Process Control V2's own bootloader uses PID `0x010C` vs. its application's `0x0113`, both under VID `0x12BF`), and the Wind Tunnel Flowcode firmware source only documents the application's identity. `main/bootloader.js` therefore takes VID/PID as required call parameters with no bootloader PID default — the Admin → Bootloader tab's "Communication settings" card has the operator enter both (VID defaults to `0x12BF`; PID has no default and must be read from Windows Device Manager while the controller is in bootloader mode). **Before first use, confirm the real bootloader PID this way and record it here.**
  - Firmware actions (`checkDevice`/`connect`/`loadHex`/`readInfo`/`erase`/`program`/`readCrc`/`jumpToApp`, exposed as `admin:bootloaderCheckDevice`/`admin:bootloaderConnect`/`admin:bootloaderLoadHex`/`admin:bootloaderReadInfo`/`admin:bootloaderErase`/`admin:bootloaderProgram`/`admin:bootloaderReadCrc`/`admin:bootloaderJumpToApp`/`admin:bootloaderDisconnect`) all require `admin.isUnlocked()` first (`main/firmware.js`'s `guarded()` wrapper, the same role its old `guard()` played), per `../AGENTS.md`'s requirement that device detection, erase, programming, and verification each need password confirmation — Process Control V2 has no such gate; it is layered on top of the ported logic. The renderer drives a Connect/Disconnect toggle (`#connectBtn`) and a client-side Erase→Program→Verify sequence (`#eraseProgramVerify`'s click handler in `renderer/app.js`, mirroring Process Control V2's `eraseProgramVerify()`) rather than a single generic action dispatch. Windows UAC elevation for erase/program is still the pre-existing stub in `main.js` (`admin:requestElevation` always declines) — that part of `../AGENTS.md`'s firmware-flashing requirement is not wired up yet; don't assume elevation is enforced.
  - There is no confirmed software command to put the running application into bootloader mode — the Flowcode firmware source documents only a touchscreen "Bootloader" menu entry (a physical action on the device), not a serial/JSON command, so the Admin UI does not attempt to trigger bootloader mode remotely; the operator must do it on the device.
  - None of this has been exercised against real hardware (no automated test suite, no bootloader-mode device available during implementation) — static syntax checks and a `--simulate` boot pass, but hardware-in-the-loop verification of erase/program/verify/run is still required before relying on it.
- Calibration writes that have a hardware readback command (`H`→`I` for scalers, `J`→`K` for LUT) re-read immediately after writing and return the hardware-confirmed value — the UI must only show a value as saved after `acknowledged: true` comes back, never optimistically.

### Renderer conventions

- `renderer/app.js` uses a single `$(id)` helper and a flat `state` object for renderer-only concerns (`liveSamples`, `experimentHistory`, `currentExperiment`, `hexPath`). For sweep-type experiments, `experimentHistory` is only appended to while `value.sweep.running` is true (from the pushed state). For `manualLog` experiments (`pressureToVelocity`, `pressureTappedCylinder`, `pressureTappedAerofoil`, `dragCoefficient`, `custom`), a point is appended only when `value.loggedPointSeq` has moved on from `state.lastLoggedPointSeq` — i.e. once per "Log Point" button click (`main/sweeps.js`'s `logPoint()`), using the row it put in `value.lastLoggedPoint`. `sensorsVsTime` is the only no-sweep experiment that stays continuous, and it never uses `experimentHistory` at all (`updateChartVisibility()` shows the live chart for it instead). `experimentHistory` represents the experiment's accumulated plot, not the rolling live buffer (`liveSamples`), and must stay independent of it. The manual, non-custom experiments above also declare an `xField` in `main/experiments.js` (`fanSpeed`/`manualAngle`/`tappingX`; the pressure-tapped experiments plot raw pressure in Pa, no Cp) so `charts.js`'s `updateHistory()` plots the real swept value on the x-axis instead of a plain sample index, matching the legacy XY plot.
- Theme is applied via `document.documentElement.setAttribute('data-theme', 'dark'|'light')` (not a body class) because `matrix-ui.css`'s DaisyUI tokens key off `[data-theme]`; preference persists to `localStorage['wind-tunnel-theme']`.
- Charts go through `renderer/charts.js`'s `WindTunnelCharts` — `configureForExperiment()` rebuilds both chart's datasets from the experiment's `liveTraces` whenever the experiment selector changes; `updateLive`/`updateHistory` are called from `app.js`'s `render()` on every `state:update` push. Never feed `historyChart` from `liveSamples`.
