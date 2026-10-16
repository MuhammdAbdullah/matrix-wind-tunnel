# Wind Tunnel App Rules

## Scope

This independent repository contains the new Windows Electron **Wind Tunnel** application. It combines Wind Tunnel Control and Wind Tunnel Calibrator in one app. The sibling `Firmware`, `Matrix Wind Tunnel 2.2`, and `Process Control V2` folders are references only and are never included in this repository’s commits or pushes.

## Hardware and connection

- Never modify the approved firmware while developing the app. The approved image is `WindTunnel V2.0.6.hex`.
- Electron main-process code owns USB/serial access. The renderer uses only the preload bridge.
- Auto-scan for USB VID `0x12BF`, PID `0xF010`; connect at `115200` baud, verify API version `2`, and retry after unplug/replug.
- Production startup must show “Searching for controller…” when hardware is absent. Do not silently enter simulation. Simulation is opt-in with `npm start -- --simulate` only.
- Preserve the existing TCP behavior. Do not invent a new network protocol.
- Use the existing binary frame `:` + command + payload + `;\n`, serialized through one command queue. Do not change command or response shapes.

## UI and responsiveness

Follow the Process Control frontend language: Matrix logo, Azonix headings, dark/light themes, sidebar navigation, status pills, responsive cards, accessible controls, and resize-safe chart panels. The layout must work at desktop, tablet, mobile, portrait, landscape, short-height, and maximized window sizes.

Control contains live sensors, fan/angle controls, experiments, sweeps, live charts, and operator actions. Admin contains connection diagnostics, API/USB identity, raw TX/RX, retry/error counts, system log, calibration, firmware, and application updates.

“Experiment History” means logged sweep/experiment points only; it must not be a copy of the rolling live sensor buffer. It remains empty until real experiment data is recorded.

## Security and verification

Admin password data must be stored only as a salted secure hash; never embed or log the bootstrap password. Firmware flashing requires Admin confirmation and Windows UAC elevation. Test USB discovery, auto-connect, API validation, reconnect, safe fan-off shutdown, control/calibrator isolation, responsive layout, both themes, charts, CSV logging, and Admin audit behavior.
