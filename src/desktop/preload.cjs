const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('paperdesk', Object.freeze({
  info: () => ipcRenderer.invoke('desktop:info'),
  preferences: value => ipcRenderer.invoke('desktop:preferences', value),
  backup: () => ipcRenderer.invoke('desktop:backup'),
  restore: () => ipcRenderer.invoke('desktop:restore'),
  importLegacy: () => ipcRenderer.invoke('desktop:legacy'),
  checkUpdates: () => ipcRenderer.invoke('desktop:updates'),
  openDataFolder: () => ipcRenderer.invoke('desktop:open-data'),
  onAction: callback => ipcRenderer.on('desktop:action', (_event, action) => callback(action)),
  onSetupProgress: callback => ipcRenderer.on('desktop:setup-progress', (_event, progress) => callback(progress)),
}));
