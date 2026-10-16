const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('windTunnel', {
    getState: () => ipcRenderer.invoke('device:getState'),
    connect: () => ipcRenderer.invoke('device:connect'),
    disconnect: () => ipcRenderer.invoke('device:disconnect'),
    setFanSpeed: (value) => ipcRenderer.invoke('device:setFanSpeed', value),
    setAngle: (value) => ipcRenderer.invoke('device:setAngle', value),
    zeroSensors: () => ipcRenderer.invoke('device:zeroSensors'),
    zeroMotor: () => ipcRenderer.invoke('device:zeroMotor'),
    calibration: (payload) => ipcRenderer.invoke('admin:calibration', payload),
    firmware: () => ipcRenderer.invoke('admin:firmware'),
    onState: (callback) => ipcRenderer.on('state:update', (_event, value) => callback(value))
});
