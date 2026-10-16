# Wind Tunnel

Windows Electron application for Matrix Wind Tunnel Control and calibration.

## Development

```powershell
npm install
npm start
```

The first build runs in safe simulation mode when no controller transport is available. The transport layer is isolated in `main.js` and follows the approved Wind Tunnel V2.0.6 framing. Hardware connection, serial device enumeration, firmware flashing, and secure Admin storage are deliberately kept behind the preload bridge.

## Git boundary

This directory is an independent Git repository. Commit and push from this directory only; the sibling `Firmware`, `Matrix Wind Tunnel 2.2`, and `Process Control V2` directories are not part of this repository.

## Safety

Do not modify or reflash firmware during normal UI development. Firmware flashing and calibration writes must remain Admin-gated and require explicit confirmation. The bootstrap password `matrix123` must never be committed, embedded, or logged.
