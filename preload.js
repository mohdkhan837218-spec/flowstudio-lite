const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Accounts
  getAccounts: () => ipcRenderer.invoke('get-accounts'),
  addAccount: (name, email) => ipcRenderer.invoke('add-account', { name: name || '', email: email || '' }),
  deleteAccount: (id) => ipcRenderer.invoke('delete-account', id),
  openLoginWindow: (id) => ipcRenderer.invoke('open-login-window', id),
  completeLogin: (id) => ipcRenderer.invoke('complete-login', id),
  syncAccount: (id) => ipcRenderer.invoke('sync-account', id),
  syncAllAccounts: () => ipcRenderer.invoke('sync-all-accounts'),
  getInstalledChromeProfiles: () => ipcRenderer.invoke('get-installed-chrome-profiles'),
  importChromeProfile: (dirName) => ipcRenderer.invoke('import-chrome-profile', dirName),
  importAllChromeProfiles: () => ipcRenderer.invoke('import-all-chrome-profiles'),
  importCookieFile: (label) => ipcRenderer.invoke('import-cookie-file', { label }),
  importCookieFilesBulk: () => ipcRenderer.invoke('import-cookie-files-bulk'),
  // v2.2.0: paste-cookies import (cookie modal)
  importCookieText: (label, text) => ipcRenderer.invoke('import-cookie-text', { label, text }),
  // v2.0.0: re-run the automatic check on an account's saved cookies
  recheckCookies: (id) => ipcRenderer.invoke('recheck-cookies', id),

  // Files & settings
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  getSetting: (key, defaultValue) => ipcRenderer.invoke('get-setting', { key, defaultValue }),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', { key, value }),
  getDefaultDownloadFolder: () => ipcRenderer.invoke('get-default-download-folder'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (event, data) => callback(data)),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  selectChromePath: () => ipcRenderer.invoke('select-chrome-path'),

  // Generation
  // v2.4.0: duplicate-charge guard — check pasted prompts against
  // still-open queue tasks BEFORE a run starts.
  checkPromptDuplicates: (prompts) => ipcRenderer.invoke('check-prompt-duplicates', { prompts }),
  startGeneration: (config) => ipcRenderer.invoke('start-generation', config),
  pauseGeneration: () => ipcRenderer.invoke('pause-generation'),
  resumeGeneration: () => ipcRenderer.invoke('resume-generation'),
  stopGeneration: () => ipcRenderer.invoke('stop-generation'),

  // v2.3.0: sequence integrity — report, missing-only retry, rename
  getSequenceReport: () => ipcRenderer.invoke('get-sequence-report'),
  retryMissingTasks: (taskIds) => ipcRenderer.invoke('retry-missing-tasks', { taskIds }),
  renameTaskFile: (taskId) => ipcRenderer.invoke('rename-task-file', { taskId }),

  // History
  getHistory: (limit) => ipcRenderer.invoke('get-history', limit),
  retryTask: (taskId) => ipcRenderer.invoke('retry-task', taskId),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  // v2.2.0: bulk-bar delete (files + records) — renderer confirms first
  deleteHistoryTasks: (ids, deleteFiles) => ipcRenderer.invoke('delete-history-tasks', { ids, deleteFiles }),

  // v1.8.0: queue resume + usage stats
  getResumableTasks: () => ipcRenderer.invoke('get-resumable-tasks'),
  resumeTasks: () => ipcRenderer.invoke('resume-tasks'),
  getUsageStats: () => ipcRenderer.invoke('get-usage-stats'),

  // v2.0.0: activity feed, credits dashboard, in-app preview, bulk prompts
  getActivity: (payload) => ipcRenderer.invoke('get-activity', payload || {}),
  clearActivity: () => ipcRenderer.invoke('clear-activity'),
  getCreditDashboard: () => ipcRenderer.invoke('get-credit-dashboard'),
  previewVideo: (taskId) => ipcRenderer.invoke('preview-video', taskId),
  importPromptsFile: () => ipcRenderer.invoke('import-prompts-file'),

  // Real-time events
  onLog: (callback) => ipcRenderer.on('automation-log', (event, data) => callback(data)),
  onProgress: (callback) => ipcRenderer.on('automation-progress', (event, data) => callback(data)),
  onWorkerUpdate: (callback) => ipcRenderer.on('worker-update', (event, data) => callback(data)),
  onVideoStarted: (callback) => ipcRenderer.on('video-started', (event, data) => callback(data)),
  onVideoProgress: (callback) => ipcRenderer.on('video-progress', (event, data) => callback(data)),
  onVideoCompleted: (callback) => ipcRenderer.on('video-completed', (event, data) => callback(data)),
  onAccountUpdated: (callback) => ipcRenderer.on('account-updated', (event, data) => callback(data)),
  onTaskUpdate: (callback) => ipcRenderer.on('task-update', (event, data) => callback(data)),
  // v2.0.0 events
  onActivityUpdate: (callback) => ipcRenderer.on('activity-update', (event, data) => callback(data)),
  onCookieCheckUpdate: (callback) => ipcRenderer.on('cookie-check-update', (event, data) => callback(data))
});
