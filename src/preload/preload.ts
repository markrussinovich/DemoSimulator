import { contextBridge, ipcRenderer } from 'electron';
import type { DemoAPI } from '../shared/model';
const api: DemoAPI = {
  newProject: () => ipcRenderer.invoke('project:new'),
  openProject: () => ipcRenderer.invoke('project:open'),
  openLegacyWorkspace: () => ipcRenderer.invoke('project:legacy'),
  currentProject: () => ipcRenderer.invoke('project:current'),
  saveProject: (catalog, projectId, saveAs) => ipcRenderer.invoke('project:save', catalog, projectId, saveAs),
  deleteProject: (catalog, projectId) => ipcRenderer.invoke('project:delete', catalog, projectId),
  importMedia: () => ipcRenderer.invoke('media:import'),
  cancelOperation: () => ipcRenderer.invoke('operation:cancel'),
  fullscreen: enabled => ipcRenderer.invoke('window:fullscreen', enabled),
  onProgress: listener => {
    const handler = (_: unknown, message: string) => listener(message);
    ipcRenderer.on('operation:progress', handler);
    return () => ipcRenderer.removeListener('operation:progress', handler);
  },
  onFullscreen: listener => {
    const handler = (_: unknown, enabled: boolean) => listener(enabled);
    ipcRenderer.on('window:fullscreen', handler);
    return () => ipcRenderer.removeListener('window:fullscreen', handler);
  },
  onFocus: listener => {
    const handler = (_: unknown, focused: boolean) => listener(focused);
    ipcRenderer.on('window:focus', handler);
    return () => ipcRenderer.removeListener('window:focus', handler);
  }
};
contextBridge.exposeInMainWorld('demo', api);
