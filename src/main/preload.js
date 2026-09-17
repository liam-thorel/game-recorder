const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    get: (id) => ipcRenderer.invoke('library:get', id),
    update: (id, patch) => ipcRenderer.invoke('library:update', id, patch),
    confirmDelete: (ids) => ipcRenderer.invoke('library:confirmDelete', ids),
    delete: (ids) => ipcRenderer.invoke('library:delete', ids),
    usage: () => ipcRenderer.invoke('library:usage'),
    reveal: (id) => ipcRenderer.invoke('library:reveal', id),
    refetch: (id) => ipcRenderer.invoke('library:refetch', id),
    onChanged: on('library:changed'),
  },
  clips: {
    export: (opts) => ipcRenderer.invoke('clip:export', opts),
    reveal: (file) => ipcRenderer.invoke('clip:reveal', file),
    openFolder: () => ipcRenderer.invoke('clips:openFolder'),
    onProgress: on('clip:progress'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
    pickDir: () => ipcRenderer.invoke('settings:pickDir'),
    micDevices: () => ipcRenderer.invoke('settings:micDevices'),
    testHenrik: (key) => ipcRenderer.invoke('settings:testHenrik', key),
  },
  status: {
    get: () => ipcRenderer.invoke('status:get'),
    onChange: on('status'),
  },
  app: {
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    openLog: () => ipcRenderer.invoke('app:openLog'),
  },
});
