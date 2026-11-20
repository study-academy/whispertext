// The notch UI's only bridge to the app. The main process also checks the sender's origin.
// (The channel prefix "studymut:" comes from the app whispertext was taken from; nobody sees it.)
const {contextBridge, ipcRenderer} = require('electron');

const listen = channel => callback => {
  const handler = (event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
};
const call = channel => (...args) => ipcRenderer.invoke('studymut:' + channel, ...args);

contextBridge.exposeInMainWorld('studymut', {
  onState: listen('studymut:state'),
  onHover: listen('studymut:hover'),
  onGesture: listen('studymut:gesture'),
  onDictationProgress: listen('studymut:dictation-progress'),
  onNotice: listen('studymut:notice'),
  onHandsFree: listen('studymut:hands-free'),
  pasteAgain: call('paste-again'),
  dragApp: () => ipcRenderer.send('studymut:drag-app'),
  handsFreeDone: call('hands-free-done'),
  handsFreeCancel: call('hands-free-cancel'),
  pillRegion: call('pill-region'),
  noticeRegion: call('notice-region'),
  targetNow: call('target-now'),
  state: call('state'),
  setMode: call('mode'),
  rowRegion: call('row-region'),
  wordSave: call('word-save'),
  wordRemove: call('word-remove'),
  permissionOpen: call('permission-open'),
  introSkip: call('intro-skip'),
  introNext: call('intro-next'),
  interactionState: call('interaction-state'),
  dictationState: call('dictation-state'),
  dictationConfig: call('dictation-config'),
  dictationAction: call('dictation-action'),
  dictationRetry: call('dictation-retry'),
  dictationAudio: call('dictation-audio'),
  dictate: call('dictate'),
  dictateAhead: call('dictate-ahead'),
  cancelDictation: call('dictation-cancel'),
  microphone: call('microphone'),
  permissionDrag: call('permission-drag'),
  permissionAction: call('permission-action'),
});
