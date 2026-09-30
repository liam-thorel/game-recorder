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
    list: () => ipcRenderer.invoke('clips:list'),
    revealByName: (name) => ipcRenderer.invoke('clips:revealByName', name),
    rename: (name, title) => ipcRenderer.invoke('clips:rename', name, title),
    confirmDelete: (names) => ipcRenderer.invoke('clips:confirmDelete', names),
    delete: (names) => ipcRenderer.invoke('clips:delete', names),
    copy: (name) => ipcRenderer.invoke('clips:copy', name),
    startDrag: (name) => ipcRenderer.send('clips:startDrag', name),
    upload: (name) => ipcRenderer.invoke('youtube:upload', name),
    onUploadProgress: on('youtube:progress'),
    onChanged: on('clips:changed'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
    pickDir: () => ipcRenderer.invoke('settings:pickDir'),
    micDevices: () => ipcRenderer.invoke('settings:micDevices'),
    testHenrik: (key) => ipcRenderer.invoke('settings:testHenrik', key),
  },
  youtube: {
    status: () => ipcRenderer.invoke('youtube:status'),
    saveCredentials: (creds) => ipcRenderer.invoke('youtube:saveCredentials', creds),
    connect: () => ipcRenderer.invoke('youtube:connect'),
    disconnect: () => ipcRenderer.invoke('youtube:disconnect'),
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
