import { contextBridge, ipcRenderer } from 'electron';
import type { DemoAPI } from '../shared/model';
function subscribe<T>(channel: string, listener: (value: T) => void) {
  const handler = (_: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
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
  },
  presentationDisplays: () => ipcRenderer.invoke('presentation:displays'),
  onPresentationDisplays: listener => subscribe('presentation:displays', listener),
  startPresentation: (displayId, videos) => ipcRenderer.invoke('presentation:start', displayId, videos),
  currentPresentation: () => ipcRenderer.invoke('presentation:current'),
  presentationState: id => ipcRenderer.invoke('presentation:state', id),
  presentationCommand: (id, command) => ipcRenderer.invoke('presentation:command', id, command),
  publishPresentationState: state => ipcRenderer.send('presentation:state', state),
  onPresentationState: listener => subscribe('presentation:state', listener),
  onPresentationCommand: listener => subscribe('presentation:command', listener),
  stopPresentation: id => ipcRenderer.invoke('presentation:stop', id),
  finishPresentation: (id, result) => ipcRenderer.invoke('presentation:finish', id, result),
  onPresentationStopped: listener => subscribe('presentation:stopped', listener)
};
contextBridge.exposeInMainWorld('demo', api);
