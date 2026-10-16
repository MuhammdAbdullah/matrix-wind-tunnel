# Wind Tunnel

Windows Electron application for Matrix Wind Tunnel Control and calibration.

## Development

```powershell
npm install
npm start
```

The production build searches automatically for the approved controller (VID `0x12BF`, PID `0xF010`) and connects at `115200` baud when it appears. Simulation is opt-in for development only: run `npm run simulate`. The transport layer is isolated in `main.js` and follows the approved Wind Tunnel V2.0.6 framing.

## Git boundary

This directory is an independent Git repository. Commit and push from this directory only; the sibling `Firmware`, `Matrix Wind Tunnel 2.2`, and `Process Control V2` directories are not part of this repository.

## Safety

Do not modify or reflash firmware during normal UI development. Firmware flashing and calibration writes must remain Admin-gated and require explicit confirmation. The bootstrap password `matrix123` must never be committed, embedded, or logged.
