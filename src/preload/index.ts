import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/api.ts';
import type { RwApi } from '../shared/api.ts';
import type { RunStatusDto } from '../shared/run-types.ts';
import type { SourcesStatusDto } from '../shared/sources-types.ts';

const api: RwApi = {
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
    resetSection: (section) => ipcRenderer.invoke(IPC.settingsResetSection, section),
  },
  doctor: {
    run: () => ipcRenderer.invoke(IPC.doctorRun),
  },
  workspace: {
    info: () => ipcRenderer.invoke(IPC.workspaceInfo),
    choose: () => ipcRenderer.invoke(IPC.workspaceChoose),
    openInFinder: () => ipcRenderer.invoke(IPC.workspaceOpenInFinder),
  },
  secrets: {
    status: () => ipcRenderer.invoke(IPC.secretsStatus),
    setMailPassword: (password) => ipcRenderer.invoke(IPC.secretsSetMailPassword, password),
  },
  countries: {
    list: () => ipcRenderer.invoke(IPC.countriesList),
    catalog: () => ipcRenderer.invoke(IPC.countriesCatalog),
    add: (input) => ipcRenderer.invoke(IPC.countriesAdd, input),
    update: (code, patch) => ipcRenderer.invoke(IPC.countriesUpdate, code, patch),
    remove: (code) => ipcRenderer.invoke(IPC.countriesRemove, code),
    setActive: (code, active) => ipcRenderer.invoke(IPC.countriesSetActive, code, active),
  },
  sources: {
    add: (code, input) => ipcRenderer.invoke(IPC.sourcesAdd, code, input),
    update: (code, id, patch) => ipcRenderer.invoke(IPC.sourcesUpdate, code, id, patch),
    remove: (code, id) => ipcRenderer.invoke(IPC.sourcesRemove, code, id),
    check: (scope) => ipcRenderer.invoke(IPC.sourcesCheck, scope),
    status: () => ipcRenderer.invoke(IPC.sourcesStatus),
    onProgress: (cb) => {
      const listener = (_e: unknown, s: SourcesStatusDto): void => cb(s);
      ipcRenderer.on(IPC.sourcesProgress, listener);
      return () => {
        ipcRenderer.removeListener(IPC.sourcesProgress, listener);
      };
    },
    discover: (code, mode) => ipcRenderer.invoke(IPC.sourcesDiscover, code, mode),
    acceptSource: (code, proposal) => ipcRenderer.invoke(IPC.sourcesAcceptSource, code, proposal),
    acceptAct: (code, proposal) => ipcRenderer.invoke(IPC.sourcesAcceptAct, code, proposal),
  },
  acts: {
    add: (code, input) => ipcRenderer.invoke(IPC.actsAdd, code, input),
    update: (code, id, patch) => ipcRenderer.invoke(IPC.actsUpdate, code, id, patch),
    remove: (code, id) => ipcRenderer.invoke(IPC.actsRemove, code, id),
  },
  mail: {
    sendTest: () => ipcRenderer.invoke(IPC.mailSendTest),
  },
  gate: {
    status: () => ipcRenderer.invoke(IPC.gateStatus),
  },
  run: {
    status: () => ipcRenderer.invoke(IPC.runStatus),
    start: (mode, opts) => ipcRenderer.invoke(IPC.runStart, mode, opts),
    stop: () => ipcRenderer.invoke(IPC.runStop),
    onProgress: (cb) => {
      const listener = (_e: unknown, s: RunStatusDto): void => cb(s);
      ipcRenderer.on(IPC.runProgress, listener);
      return () => {
        ipcRenderer.removeListener(IPC.runProgress, listener);
      };
    },
  },
  schedule: {
    status: () => ipcRenderer.invoke(IPC.scheduleStatus),
  },
  skills: {
    list: () => ipcRenderer.invoke(IPC.skillsList),
    read: (name) => ipcRenderer.invoke(IPC.skillsRead, name),
  },
  app: {
    completeOnboarding: () => ipcRenderer.invoke(IPC.appCompleteOnboarding),
  },
  history: {
    list: () => ipcRenderer.invoke(IPC.historyList),
    country: (runId, code) => ipcRenderer.invoke(IPC.historyCountry, runId, code),
    openFolder: (runId, code) => ipcRenderer.invoke(IPC.historyOpen, runId, code),
    addCase: (input) => ipcRenderer.invoke(IPC.historyAddCase, input),
    cases: () => ipcRenderer.invoke(IPC.historyCases),
  },
};

contextBridge.exposeInMainWorld('rw', api);
