/** Exposes a narrow, typed bridge on `window.connector`; nothing else of Node or Electron. */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type ConnectorBridge, type UiState } from '../shared/ipc';

const bridge: ConnectorBridge = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  pair: (code, deviceName) => ipcRenderer.invoke(IPC.pair, code, deviceName),
  unpair: () => ipcRenderer.invoke(IPC.unpair),
  addAccount: (token) => ipcRenderer.invoke(IPC.addAccount, token),
  removeAccount: (discordUserId) => ipcRenderer.invoke(IPC.removeAccount, discordUserId),
  setPaused: (paused) => ipcRenderer.invoke(IPC.setPaused, paused),
  setAutoStart: (enabled) => ipcRenderer.invoke(IPC.setAutoStart, enabled),
  onState: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, state: UiState) => listener(state);
    ipcRenderer.on(IPC.stateChanged, handler);
    return () => ipcRenderer.removeListener(IPC.stateChanged, handler);
  },
};

contextBridge.exposeInMainWorld('connector', bridge);
