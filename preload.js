'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  onState: fn => ipcRenderer.on('state', (_, v) => fn(v)),
  onCursor: fn => ipcRenderer.on('cursor', (_, v) => fn(v)),
  onGeometry: fn => ipcRenderer.on('geometry', (_, v) => fn(v)),
  onRecapture: fn => ipcRenderer.on('recapture', () => fn()),
  geometry: () => ipcRenderer.invoke('geometry'),
  captureSource: () => ipcRenderer.invoke('capture-source'),
  setIgnore: ignore => ipcRenderer.send('ignore', ignore),
  menu: () => ipcRenderer.send('menu'),
  openProject: cwd => ipcRenderer.send('open-project', cwd),
  focus: on => ipcRenderer.invoke('focus', on),
  ready: () => ipcRenderer.send('ready'),
});
