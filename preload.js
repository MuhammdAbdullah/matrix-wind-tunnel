const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('windTunnel', {
    getState: () => ipcRenderer.invoke('device:getState'),
    listPorts: () => ipcRenderer.invoke('device:listPorts'),
    connectPort: (port, baudRate) => ipcRenderer.invoke('device:connectPort', port, baudRate),
    connect: () => ipcRenderer.invoke('device:connect'),
    disconnect: () => ipcRenderer.invoke('device:disconnect'),
    setFanSpeed: (value) => ipcRenderer.invoke('device:setFanSpeed', value),
    setAngle: (value) => ipcRenderer.invoke('device:setAngle', value),
    zeroSensors: () => ipcRenderer.invoke('device:zeroSensors'),
    zeroMotor: () => ipcRenderer.invoke('device:zeroMotor'),
    sendCommand: (command, payload) => ipcRenderer.invoke('device:sendCommand', command, payload),
    getDiagnostics: () => ipcRenderer.invoke('device:getDiagnostics'),
    calibration: (payload) => ipcRenderer.invoke('admin:calibration', payload),
    firmware: () => ipcRenderer.invoke('admin:firmware'),
    adminStatus: () => ipcRenderer.invoke('admin:status'),
    verifyAdmin: (password) => ipcRenderer.invoke('admin:verify', password),
    setupAdmin: (password) => ipcRenderer.invoke('admin:setup', password),
    requestElevation: () => ipcRenderer.invoke('admin:requestElevation'),
    onState: (callback) => ipcRenderer.on('state:update', (_event, value) => callback(value))
});
