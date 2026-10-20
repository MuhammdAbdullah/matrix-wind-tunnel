# Wind Tunnel

Windows Electron application combining Matrix Wind Tunnel Control and Calibrator: live sensor readout, the 8-experiment suite with angle/fan sweeps and CSV logging, scaler/LUT calibration, and Admin-gated firmware (bootloader) updates.

## Development

```powershell
npm install
npm start            # auto-scans for the real USB controller
npm run simulate      # synthetic sensor data, no hardware needed
npm run dev           # Electron with --dev flag
npm run build-win     # electron-builder Windows NSIS installer -> dist/
npm run rebuild-hid   # rebuild the native node-hid module against Electron's ABI
```

The production build searches automatically for the approved controller (VID `0x12BF`, PID `0xF010`) and connects at `115200` baud when it appears. Simulation is opt-in for development only: run `npm run simulate`. There is no automated test suite — verify changes with `npm run simulate` and/or against real hardware.

## Architecture

Main-process logic lives in `main/` modules, required from a slim `main.js` (window creation + IPC wiring only): `protocol.js` (binary framing), `state.js` (shared state + push updates), `serial.js` (SerialPort transport, auto-connect/reconnect), `admin.js` (Admin password/session), `experiments.js` (the 8-experiment table), `sweeps.js` (sweep timers + logging triggers), `calibration.js` (scaler/LUT/display/network writes), `bootloader.js` (HID bootloader transport/protocol) and `firmware.js` (bootloader orchestration), and `logging.js` (CSV output). `preload.js` exposes this to the renderer as `window.windTunnel.*`; `renderer/app.js` and `renderer/charts.js` (Chart.js) drive the UI with no bundler or framework. See `CLAUDE.md` for the full module layout, dependency graph, and protocol/calibration/bootloader details.

## Git boundary

This directory is an independent Git repository. Commit and push from this directory only; the sibling `Firmware`, `Matrix Wind Tunnel 2.2`, and `Process Control V2` directories are **read-only references** — not part of this repository, and never to be edited.

## Safety

Do not modify or reflash firmware during normal UI development. Firmware flashing (bootloader erase/program/verify) and calibration writes must remain Admin-gated and require explicit confirmation. The bootstrap password `matrix123` must never be committed, embedded, or logged. The bootloader's USB PID is not yet hardware-confirmed — see `CLAUDE.md` before relying on firmware updates.
