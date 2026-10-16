# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Scope and git boundary

This directory is its own independent Git repository (`matrix-wind-tunnel`) — the new Windows Electron app combining **Wind Tunnel Control** and **Wind Tunnel Calibrator**. Commit and push only from here. The sibling folders one level up (`Firmware/`, `Matrix Wind Tunnel 2.2/`, `Process Control V2/`) are reference material only and are never part of this repo's commits — see `../AGENTS.md` for the full behavioral spec those references define (protocol tables, experiment/graph rules, Admin requirements, firmware constraints). Read that file before implementing any protocol, calibration, or experiment behavior; this CLAUDE.md only covers what's inside this repo.

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
  firmware.js      Firmware admin action handler — see "Firmware stub" below
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

**Module dependency direction** (no circular requires): `state.js` and `protocol.js` are leaves; `serial.js` depends on both; `logging.js` depends on `state.js`; `sweeps.js` depends on `serial.js` + `logging.js` + `experiments.js`; `calibration.js` depends on `serial.js` + `admin.js`; `firmware.js` depends on `serial.js`. Cross-module reactions (e.g. "stop the sweep on an unexpected disconnect") go through `serial.onUnexpectedDisconnect(listener)` rather than `serial.js` requiring `sweeps.js` back — keep new cross-cutting hooks in that direction (the dependent module registers a listener on the module it depends on, never the reverse).

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

`sweeps.js` runs up to two independent timers (never more than one sweep at a time): the sensor-sample timer (`startSensorSampleTimer`, skips its own read while a sweep tick is active to avoid duplicate serial round-trips) and the active sweep timer (`startAngleSweep`/`startFanSweep`). A sweep **auto-stops at `end` and resets `current` to `start` — it never reverses or loops**; manual `stopSweep()` resets to `start` too, for consistency. Tapping channel auto-advances by `tapping.increment` after each logged point and wraps `23 -> 1`.

`logging.js` writes `WindTunnelLog_<timestamp>.csv` using the active experiment's `csvColumns` as the header, to a folder persisted in `wind-tunnel-config.json` (separate file from the admin credential). `appendRow()` is called from the sweep tick for sweep-driven experiments and from the sensor-sample timer for the two experiments with no sweep (`sensorsVsTime`, `pressureToVelocity`).

### Admin / security

- Admin credential is a scrypt hash + random salt in `wind-tunnel-admin.json` under Electron's `userData` path (`main/admin.js`). Plaintext password is never persisted or logged. `admin.unlock()` sets a 10-minute expiry (`SESSION_TIMEOUT_MS`); `isUnlocked()` is checked lazily (no background timer) and is the **authoritative** gate for calibration writes — `main/calibration.js`'s `guard()` checks `admin.isUnlocked()` and `!state.sweep.running` server-side, not just in the renderer (the renderer's own checks are fast-path UX only, bypassing them must not be enough to write calibration).
- `main/firmware.js` intentionally refuses every action except `detect` (which only lists serial ports, no bootloader claim) with `{ok: false, reason: 'protocol-unconfirmed'}`. This is **not a TODO** — the Wind Tunnel bootloader's USB identity and command protocol are not documented anywhere in this codebase (confirmed by research across `../Firmware/`), and Process Control V2's bootloader protocol (different SOH/EOT HID framing, different PID) must never be substituted — that risks bricking the controller. Do not wire up real erase/program/verify/run without first confirming the real protocol against hardware or vendor documentation.
- Calibration writes that have a hardware readback command (`H`→`I` for scalers, `J`→`K` for LUT) re-read immediately after writing and return the hardware-confirmed value — the UI must only show a value as saved after `acknowledged: true` comes back, never optimistically.

### Renderer conventions

- `renderer/app.js` uses a single `$(id)` helper and a flat `state` object for renderer-only concerns (`liveSamples`, `experimentHistory`, `currentExperiment`, `hexPath`). `experimentHistory` is only appended to while `value.sweep.running` is true (from the pushed state) — it represents logged experiment data, not the rolling live buffer (`liveSamples`), and must stay independent of it.
- Theme is applied via `document.documentElement.setAttribute('data-theme', 'dark'|'light')` (not a body class) because `matrix-ui.css`'s DaisyUI tokens key off `[data-theme]`; preference persists to `localStorage['wind-tunnel-theme']`.
- Charts go through `renderer/charts.js`'s `WindTunnelCharts` — `configureForExperiment()` rebuilds both chart's datasets from the experiment's `liveTraces` whenever the experiment selector changes; `updateLive`/`updateHistory` are called from `app.js`'s `render()` on every `state:update` push. Never feed `historyChart` from `liveSamples`.
