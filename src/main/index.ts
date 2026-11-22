import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, powerMonitor, powerSaveBlocker, shell, Tray } from 'electron';
import { IPC } from '../shared/api.ts';
import type { ResetSection, SettingsUpdateResult } from '../shared/api.ts';
import { addCountry, addSource, addWatchedAct, loadCountries, removeCountry, removeSource, removeWatchedAct, setCountryActive, updateCountry, updateSource, updateWatchedAct } from './countries/store.ts';
import type { ActInput, ActPatch, CountryInput, CountryPatch, SourceInput, SourcePatch } from './countries/store.ts';
import { getCatalog } from './countries/catalog.ts';
import { canCompleteOnboarding, guardRun } from './mail-gate.ts';
import { createCollector } from './collect/collector.ts';
import { createFetcher } from './collect/fetcher.ts';
import { buildClaudeEnv, findClaude, stripClaudeEnv } from './env.ts';
import { createStageExecutors, createTranslator, NO_CLAUDE_MESSAGE, NO_CLAUDE_MESSAGE_EN } from './runner/executors.ts';
import { createFinalize, mailFailedText, mailStatusFor, noticeText, processMailQueue } from './runner/finalize.ts';
import type { MailQueueDeps } from './runner/finalize.ts';
import { sendMail } from './mail/smtp.ts';
import { Orchestrator } from './runner/orchestrator.ts';
import { findUnfinishedRun } from './runner/run-state.ts';
import { createBudget, observingRunStage } from './runner/budget.ts';
import { runStage as realRunStage } from './runner/claude-runner.ts';
import { createResumeTimer, formatPauseTime, keepAwakeDuringPause, pauseNotice, resumedNotice } from './auto-resume.ts';
import type { RunState } from '../shared/run-types.ts';
import { createRunController } from './run-controller.ts';
import { createScheduler } from './scheduler.ts';
import { createSourcesController } from './sources/sources-controller.ts';
import type { ActProposalDto, SourceCheckScope, SourceProposalDto } from '../shared/sources-types.ts';
import type { RunStartMode, RunStartOptions } from '../shared/run-types.ts';
import { sanitizeRendererPatch } from './settings/sanitize.ts';
import { getGateStatus, invalidateMailVerification, sendTestMailFromSettings } from './mail/service.ts';
import { resetSection } from './settings/reset.ts';
import type { SettingsPatch } from '../shared/types.ts';
import { runDoctor } from './doctor.ts';
import { getSecret, hasSecret, setSecret } from './secrets.ts';
import { loadSettings, updateSettings } from './settings/store.ts';
import { trayIcon } from './tray-icon.ts';
import { ensureWorkspace } from './workspace.ts';
import { langOf, mt } from './i18n.ts';
import { getCountryRun, listRuns as listHistoryRuns, resolveOpenTarget } from './history.ts';
import { addGoldenCase, CANDIDATE_ID_MAX, COMMENT_MAX, listGoldenCases, URL_MAX } from './golden-cases.ts';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';

// Имя задаём до ready, чтобы userData был ~/Library/Application Support/RegWatch.
app.setName('RegWatch');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

const settingsDir = (): string => app.getPath('userData');

// ---- Прогон: оркестратор с боевыми этапами (создаётся после подготовки рабочей папки) ----

let orchestrator: Orchestrator | null = null;
/** Хеш набора скиллов из ensureWorkspace (NFR-15) — пишется в run.json. */
let skillsHash = '';
/** Пояснение для окна «Прогон» (почему незавершённая проверка не продолжилась). */
let runNotice = '';
/** Идёт попытка продолжить незавершённый прогон (чтобы планировщик не начал новый параллельно). */
let resuming: Promise<void> | null = null;

/**
 * RUN-06/NFR-06: автопродолжение после паузы по лимиту. Таймер сверяется с настенными часами шагами ≤ 1 мин и
 * пересчитывается при пробуждении Mac; после перезапуска приложения срок берётся из run.json (resumeUnfinished).
 * Запуск — через 1 с: оркестратор, только что вставший на паузу, должен успеть освободиться.
 */
const autoResume = createResumeTimer({
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
  fire: () => {
    setPauseAwake(false);
    setTimeout(() => void resumeUnfinished(), 1_000);
  },
});
/** Последняя пауза, о которой уже сообщили уведомлением (чтобы не повторять). */
let notifiedPause: string | null = null;
/** RUN-05: короткую паузу (≤ 30 мин) Mac пережидает без сна; длинную — спит, таймер догонит после пробуждения. */
let pauseBlocker: number | null = null;
function setPauseAwake(on: boolean): void {
  try {
    if (on && pauseBlocker === null) pauseBlocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!on && pauseBlocker !== null) {
      if (powerSaveBlocker.isStarted(pauseBlocker)) powerSaveBlocker.stop(pauseBlocker);
      pauseBlocker = null;
    }
  } catch (err) {
    logLine('power-save', err instanceof Error ? err.message : String(err));
  }
}

/** Взвести автопродолжение и пояснение в окне «Прогон» для паузы до pausedUntil. */
function armPause(pausedUntil: string): void {
  const L = uiLang();
  const when = formatPauseTime(pausedUntil, new Date(), L);
  runNotice = mt(L, `Проверка на паузе до ${when} — лимит Claude. Продолжится автоматически.`, `The check is paused until ${when} — Claude limit. It will resume automatically.`);
  setPauseAwake(keepAwakeDuringPause(pausedUntil, Date.now()));
  autoResume.arm(pausedUntil);
  runController.notify();
}

/** Каждая запись run.json: пауза → уведомление macOS (один раз) и таймер продолжения. */
function onRunState(s: RunState): void {
  if (!s.paused_until || s.paused_until === notifiedPause) return;
  notifiedPause = s.paused_until;
  const n = pauseNotice(s.paused_until, new Date(), uiLang());
  notifyMac(n.title, n.body);
  armPause(s.paused_until);
}

/** Окружение для claude: login shell без CLAUDE_* (NFR-11); считается один раз. */
let claudeEnvP: Promise<Record<string, string>> | null = null;
const claudeEnv = (): Promise<Record<string, string>> =>
  (claudeEnvP ??= buildClaudeEnv().catch(() => stripClaudeEnv(process.env)));
/** Путь к claude: настройка «Дополнительно» → PATH login shell → стандартные места. Каждый раз заново (настройка могла смениться). */
/** Язык интерфейса из текущих сохранённых настроек (для текстов окна, трея и диалогов). */
const uiLang = () => langOf(loadSettings(settingsDir()));
const noClaudeMsg = (): string => mt(uiLang(), NO_CLAUDE_MESSAGE, NO_CLAUDE_MESSAGE_EN);

const claudeBin = async (): Promise<string | null> =>
  findClaude({ configured: loadSettings(settingsDir()).advanced.claudePath || null, env: await claudeEnv() });

const runController = createRunController({
  workspaceDir: () => loadSettings(settingsDir()).workspaceDir,
  getSettings: () => loadSettings(settingsDir()),
  gate: () => getGateStatus(loadSettings(settingsDir()), hasSecret('mailPassword')),
  getCountries: () => loadCountries(settingsDir()),
  orchestrator: () => orchestrator,
  skillsHash: () => skillsHash,
  preflight: async () => {
    // Проверка источников и прогон не идут одновременно (одни и те же сайты и лимит Claude).
    if (sourcesController.running) {
      return mt(uiLang(), 'Сейчас идёт проверка источников. Дождитесь её окончания и запустите снова.', 'A source check is running now. Wait for it to finish and start again.');
    }
    const bin = await claudeBin();
    if (!bin) return noClaudeMsg();
    runNotice = '';
    return null;
  },
  notice: () => runNotice,
  mailStatus: (run) => mailStatusFor(loadSettings(settingsDir()).workspaceDir, run, uiLang()),
});

/** Проверка и поиск источников (фаза 6): фоновые задания, по одному; во время прогона — отказ. */
const sourcesController = createSourcesController({
  fetcher: () => createFetcher(),
  workspaceDir: () => loadSettings(settingsDir()).workspaceDir,
  countriesDir: () => settingsDir(),
  getSettings: () => loadSettings(settingsDir()),
  isRunBusy: () => !!orchestrator?.running,
  preflight: async () => ((await claudeBin()) ? null : noClaudeMsg()),
  schemasDir: schemasDir(),
  claudeBin,
  claudeEnv,
});

/**
 * Расписания (RUN-01/03): таймер раз в 30 с, при запуске приложения и при пробуждении Mac.
 * Сработавшие расписания идут по очереди (один прогон за раз, RUN-07), страны в пачке не повторяются;
 * незавершённый прогон продолжается раньше новых (RUN-06). Отказ (почта, claude) — пояснение в окне «Прогон».
 */
const scheduler = createScheduler({
  getSettings: () => loadSettings(settingsDir()),
  getCountries: () => loadCountries(settingsDir()),
  isBusy: () => !orchestrator || orchestrator.running || sourcesController.running || resuming !== null,
  hasUnfinished: () => !!findUnfinishedRun(loadSettings(settingsDir()).workspaceDir),
  resumeUnfinished: () => resumeUnfinished(),
  startRun: async (_entry, countries) => {
    // Гейт почты (guardRun) и наличие claude проверяет runController.start (preflight).
    const r = await runController.start('scheduled', { countries });
    return { started: r.started === true, message: r.message };
  },
  notice: (text) => {
    runNotice = text;
    runController.notify();
  },
  log: (kind, detail) => logLine(kind, detail),
});

function schemasDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'schemas') : join(app.getAppPath(), 'schemas');
}

// ---- Почта (DLV-05/06) и уведомления macOS (DLV-07) ----

/** Уведомление macOS; клик открывает окно. Ошибка уведомления не мешает работе. */
function notifyMac(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    n.on('click', () => showWindow());
    n.show();
  } catch (err) {
    logLine('notification', err instanceof Error ? err.message : String(err));
  }
}

/** Отправка одного письма очереди: пароль приложения читается из safeStorage только здесь, в main. */
const mailQueueDeps: MailQueueDeps = {
  getSettings: () => loadSettings(settingsDir()),
  send: async (entry, settings) => {
    const password = getSecret('mailPassword') ?? '';
    await sendMail({ mail: settings.mail, password, to: entry.to, subject: entry.subject, text: entry.text, html: entry.html });
  },
  onOutboxChange: () => runController.notify(),
};

let outboxTimer: NodeJS.Timeout | undefined;
let outboxBusy = false;

/** Обработка очереди писем (повторы через 15 минут, DLV-06): при старте, раз в минуту и при пробуждении Mac. */
async function tickOutbox(): Promise<void> {
  if (outboxBusy) return;
  outboxBusy = true;
  try {
    const ws = loadSettings(settingsDir()).workspaceDir;
    await processMailQueue(ws, {
      ...mailQueueDeps,
      onOutboxChange: (e) => {
        runController.notify();
        if (e.status === 'failed') {
          const t = mailFailedText(e, uiLang());
          notifyMac(t.title, t.body);
        }
      },
    });
  } catch (err) {
    logLine('outbox', err instanceof Error ? err.message : String(err));
  } finally {
    outboxBusy = false;
  }
}

/** Оркестратор с настоящими исполнителями: сбор (код), модель (`claude -p`), проверка цитат (код). */
function createOrchestrator(): Orchestrator {
  const fetcher = createFetcher();
  // NFR-06: бюджет 5-часового лимита. Данные — rate_limit_event каждого процесса (обёртка runStage) →
  // <рабочая папка>/state/rate_limit.json; порог — текущее значение ползунка «Расход».
  const budget = createBudget({
    workspaceDir: () => loadSettings(settingsDir()).workspaceDir,
    getSettings: () => loadSettings(settingsDir()),
    log: (event, text) => logLine(event, text),
  });
  const runStage = observingRunStage(realRunStage, budget);
  const executors = createStageExecutors({
    workspaceDir: () => loadSettings(settingsDir()).workspaceDir,
    getSettings: () => loadSettings(settingsDir()),
    schemasDir: schemasDir(),
    claudeBin,
    claudeEnv,
    fetcher,
    // Сборщик создаётся на каждый вызов: рабочая папка берётся из прогона (её могли сменить в настройках).
    collector: { collect: (ctx) => createCollector({ fetcher, workspaceDir: ctx.workspaceDir, countriesDir: settingsDir() }).collect(ctx) },
    runStage,
    budget,
  });
  let blocker: number | null = null;
  return new Orchestrator({
    executors,
    budget,
    // RUN-05: Mac не засыпает, пока идёт прогон.
    powerSave: {
      start: () => {
        blocker = powerSaveBlocker.start('prevent-app-suspension');
      },
      stop: () => {
        if (blocker !== null && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
        blocker = null;
      },
    },
    onProgress: (s) => {
      runController.notify();
      onRunState(s);
    },
    // Шаги 7–10: дайджест, перевод (translate-ru), очередь писем и журнал отправленного после успешной отправки.
    finalize: createFinalize({
      ...mailQueueDeps,
      getCountries: () => loadCountries(settingsDir()),
      translate: createTranslator({ schemasDir: schemasDir(), claudeBin, claudeEnv, runStage, budget }),
      notify: (n) => {
        const t = noticeText(n, uiLang());
        notifyMac(t.title, t.body);
      },
    }),
  });
}

/**
 * RUN-06: при запуске приложения продолжить незавершённый и не остановленный пользователем прогон.
 * Почта не настроена или нет claude — не падаем, а объясняем в окне «Прогон».
 */
function resumeUnfinished(): Promise<void> {
  if (resuming) return resuming;
  resuming = doResumeUnfinished().finally(() => {
    resuming = null;
  });
  return resuming;
}

async function doResumeUnfinished(): Promise<void> {
  if (!orchestrator || orchestrator.running) return;
  try {
    const settings = loadSettings(settingsDir());
    const found = findUnfinishedRun(settings.workspaceDir);
    if (!found) return;
    const g = guardRun(found.state.mode, getGateStatus(settings, hasSecret('mailPassword')));
    if (!g.allowed) {
      runNotice = mt(
        langOf(settings),
        `Незавершённая проверка (${found.state.id}) не продолжена: ${g.message}`,
        `The unfinished check (${found.state.id}) was not resumed: ${g.message}`,
      );
      runController.notify();
      return;
    }
    if (!(await claudeBin())) {
      runNotice = mt(
        langOf(settings),
        `Незавершённая проверка (${found.state.id}) не продолжена. ${NO_CLAUDE_MESSAGE}`,
        `The unfinished check (${found.state.id}) was not resumed. ${NO_CLAUDE_MESSAGE_EN}`,
      );
      runController.notify();
      return;
    }
    const pausedUntil = found.state.paused_until;
    const until = pausedUntil ? Date.parse(pausedUntil) : NaN;
    if (pausedUntil && Number.isFinite(until) && until > Date.now()) {
      // Пауза по лимиту ещё не кончилась (в т.ч. после перезапуска приложения): таймер продолжит в момент сброса.
      armPause(pausedUntil);
      return;
    }
    runNotice = '';
    autoResume.cancel();
    setPauseAwake(false);
    const p = orchestrator.resume({ countries: loadCountries(settingsDir()), settings });
    if (pausedUntil) {
      notifiedPause = null;
      const n = resumedNotice(langOf(settings));
      notifyMac(n.title, n.body);
    }
    runController.notify();
    p.then(
      () => runController.notify(),
      (err: unknown) => {
        logLine('resume', err instanceof Error ? err.message : String(err));
        runController.notify();
      },
    );
  } catch (err) {
    logLine('resume', err instanceof Error ? err.message : String(err));
  }
}

function sources(): { skillsSrc: string; goldenSrc: string } {
  if (app.isPackaged) {
    return { skillsSrc: join(process.resourcesPath, 'skills'), goldenSrc: join(process.resourcesPath, 'golden') };
  }
  const root = app.getAppPath();
  return { skillsSrc: join(root, 'skills'), goldenSrc: join(root, 'docs', 'golden') };
}

/** Создаёт рабочую папку; ошибка показывается диалогом, приложение продолжает работать. */
function prepareWorkspace(dir: string): boolean {
  try {
    skillsHash = ensureWorkspace({ dir, ...sources(), lang: uiLang() }).skillsHash;
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const L = uiLang();
    dialog.showErrorBox(
      mt(L, 'Не удалось подготовить рабочую папку', 'Could not prepare the working folder'),
      mt(L, `Папка: ${dir}\n\n${msg}\n\nВыберите другую папку в Настройках → Папки.`, `Folder: ${dir}\n\n${msg}\n\nChoose another folder in Settings → Folders.`),
    );
    return false;
  }
}

function showWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Журнал сбоев окна: ~/Library/Application Support/RegWatch/main.log (для поддержки, без секретов). */
function logLine(kind: string, detail: string): void {
  try {
    appendFileSync(join(settingsDir(), 'main.log'), `${new Date().toISOString()} ${kind} ${detail}\n`);
  } catch {
    /* журнал не должен ронять приложение */
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'RegWatch',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win?.show());
  const wc = win.webContents;
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    logLine('did-fail-load', `${code} ${desc} ${url} main=${isMain}`);
    if (isMain && win && !win.isVisible()) win.show(); // не оставляем невидимое окно без объяснения
  });
  wc.on('render-process-gone', (_e, d) => {
    logLine('render-process-gone', `${d.reason} exit=${d.exitCode}`);
    if (d.reason !== 'clean-exit' && !wc.isDestroyed()) wc.reload();
  });
  wc.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') logLine('console.' + e.level, `${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  // Крестик прячет окно: приложение живёт в трее.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
  // Внешние ссылки — только https и только в системном браузере.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault();
      if (url.startsWith('https://')) void shell.openExternal(url);
    }
  });
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

function trayMenu(): Menu {
  const L = uiLang();
  return Menu.buildFromTemplate([
    {
      label: mt(L, 'Проверить сейчас', 'Check now'),
      click: () => {
        showWindow();
        void runController.start('manual').then((r) => {
          if (!r.ok) void dialog.showMessageBox({ type: 'info', message: mt(uiLang(), 'Проверка не запущена', 'The check was not started'), detail: r.message });
        });
      },
    },
    { label: mt(L, 'Открыть RegWatch', 'Open RegWatch'), click: () => showWindow() },
    { type: 'separator' },
    { label: mt(L, 'Выйти', 'Quit'), click: () => app.quit() },
  ]);
}

function createTray(): void {
  tray = new Tray(trayIcon());
  tray.setToolTip('RegWatch');
  tray.setContextMenu(trayMenu());
}

const RESET_SECTIONS: readonly string[] = ['search', 'schedule', 'mail', 'spend', 'folders', 'advanced', 'all'];

function listSkills(): string[] {
  try {
    return readdirSync(sources().skillsSrc, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(sources().skillsSrc, e.name, 'SKILL.md')))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** RUN-04: автозапуск при входе, только в установленном приложении. */
function applyLoginItem(openAtLogin: boolean): void {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin });
  } catch (err) {
    logLine('login-item', err instanceof Error ? err.message : String(err));
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => loadSettings(settingsDir()));
  ipcMain.handle(IPC.settingsUpdate, (_e, patch: SettingsPatch): SettingsUpdateResult => {
    // Служебные поля (почта проверена, мастер пройден) из окна менять нельзя.
    const safe = sanitizeRendererPatch(patch);
    const before = loadSettings(settingsDir());
    const r = updateSettings(settingsDir(), safe);
    if (r.ok && typeof safe.launchAtLogin === 'boolean') applyLoginItem(r.settings.launchAtLogin);
    if (r.ok && r.settings.uiLanguage !== before.uiLanguage) tray?.setContextMenu(trayMenu());
    // Новое или изменённое время отсчитывается от «сейчас»: прошедшее сегодня не догоняется.
    if (r.ok && safe.schedules !== undefined) scheduler.settingsChanged(before.schedules, r.settings.schedules);
    return { ok: r.ok, errors: r.errors, settings: r.settings };
  });
  ipcMain.handle(IPC.settingsResetSection, (_e, section: ResetSection): SettingsUpdateResult => {
    if (!RESET_SECTIONS.includes(section)) return { ok: false, errors: { section: mt(uiLang(), 'Неизвестный раздел', 'Unknown section') }, settings: loadSettings(settingsDir()) };
    const before = loadSettings(settingsDir());
    const settings = resetSection(settingsDir(), section);
    if (settings.uiLanguage !== before.uiLanguage) tray?.setContextMenu(trayMenu());
    if (settings.launchAtLogin !== before.launchAtLogin) applyLoginItem(settings.launchAtLogin);
    scheduler.settingsChanged(before.schedules, settings.schedules);
    if (settings.workspaceDir !== before.workspaceDir) prepareWorkspace(settings.workspaceDir);
    return { ok: true, errors: {}, settings };
  });
  ipcMain.handle(IPC.countriesList, () => loadCountries(settingsDir()));
  ipcMain.handle(IPC.countriesCatalog, () => getCatalog());
  ipcMain.handle(IPC.countriesAdd, (_e, input: CountryInput) => addCountry(settingsDir(), input));
  ipcMain.handle(IPC.countriesUpdate, (_e, code: string, patch: CountryPatch) => updateCountry(settingsDir(), code, patch));
  ipcMain.handle(IPC.countriesRemove, (_e, code: string) => removeCountry(settingsDir(), code));
  ipcMain.handle(IPC.countriesSetActive, (_e, code: string, active: boolean) => setCountryActive(settingsDir(), code, active));
  ipcMain.handle(IPC.sourcesAdd, (_e, code: string, input: SourceInput) => addSource(settingsDir(), code, input));
  ipcMain.handle(IPC.sourcesUpdate, (_e, code: string, id: string, patch: SourcePatch) => updateSource(settingsDir(), code, id, patch));
  ipcMain.handle(IPC.sourcesRemove, (_e, code: string, id: string) => removeSource(settingsDir(), code, id));
  ipcMain.handle(IPC.sourcesCheck, (_e, scope: unknown) => {
    const sc = (scope && typeof scope === 'object' ? scope : {}) as SourceCheckScope;
    return sourcesController.check({
      ...(typeof sc.code === 'string' ? { code: sc.code } : {}),
      ...(typeof sc.sourceId === 'string' ? { sourceId: sc.sourceId } : {}),
      ...(sc.all === true ? { all: true } : {}),
    });
  });
  ipcMain.handle(IPC.sourcesStatus, () => sourcesController.status());
  ipcMain.handle(IPC.sourcesDiscover, (_e, code: unknown, mode: unknown) => {
    if (typeof code !== 'string' || (mode !== 'missing' && mode !== 'watched')) return { ok: false, message: mt(uiLang(), 'Неизвестный режим поиска.', 'Unknown search mode.'), sourceProposals: [], actProposals: [] };
    return sourcesController.discover(code, mode);
  });
  ipcMain.handle(IPC.sourcesAcceptSource, (_e, code: string, proposal: SourceProposalDto) => sourcesController.acceptSource(code, proposal));
  ipcMain.handle(IPC.sourcesAcceptAct, (_e, code: string, proposal: ActProposalDto) => sourcesController.acceptAct(code, proposal));
  sourcesController.onChange(() => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.sourcesProgress, sourcesController.status());
  });
  ipcMain.handle(IPC.actsAdd, (_e, code: string, input: ActInput) => addWatchedAct(settingsDir(), code, input));
  ipcMain.handle(IPC.actsUpdate, (_e, code: string, id: string, patch: ActPatch) => updateWatchedAct(settingsDir(), code, id, patch));
  ipcMain.handle(IPC.actsRemove, (_e, code: string, id: string) => removeWatchedAct(settingsDir(), code, id));
  ipcMain.handle(IPC.mailSendTest, () =>
    sendTestMailFromSettings({
      settingsDir: settingsDir(),
      getPassword: () => {
        try {
          return getSecret('mailPassword');
        } catch {
          return null;
        }
      },
    }),
  );
  ipcMain.handle(IPC.gateStatus, () => getGateStatus(loadSettings(settingsDir()), hasSecret('mailPassword')));
  ipcMain.handle(IPC.runStatus, () => runController.status());
  ipcMain.handle(IPC.runStart, (_e, mode: unknown, opts: unknown) => {
    if (mode !== 'manual' && mode !== 'dry_run' && mode !== 'backfill') return { ok: false, message: mt(uiLang(), 'Неизвестный режим запуска.', 'Unknown run mode.') };
    return runController.start(mode as RunStartMode, (opts && typeof opts === 'object' ? opts : {}) as RunStartOptions);
  });
  ipcMain.handle(IPC.runStop, () => runController.stop());
  ipcMain.handle(IPC.scheduleStatus, () => scheduler.status());
  runController.onChange(() => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.runProgress, runController.status());
  });
  ipcMain.handle(IPC.skillsList, () => listSkills());
  ipcMain.handle(IPC.skillsRead, (_e, name: unknown) => {
    // Имя проверяется по списку: никаких путей.
    if (typeof name !== 'string' || !listSkills().includes(name)) throw new Error(mt(uiLang(), 'Такого скилла нет', 'No such skill'));
    return readFileSync(join(sources().skillsSrc, name, 'SKILL.md'), 'utf8');
  });
  ipcMain.handle(IPC.appCompleteOnboarding, () => {
    const guard = canCompleteOnboarding(loadSettings(settingsDir()), hasSecret('mailPassword'));
    if (!guard.allowed) throw new Error(guard.message);
    updateSettings(settingsDir(), { onboardingDone: true });
  });
  ipcMain.handle(IPC.doctorRun, () => {
    const s = loadSettings(settingsDir());
    return runDoctor({ configuredClaudePath: s.advanced.claudePath || null, workspaceDir: s.workspaceDir, lang: langOf(s) });
  });
  ipcMain.handle(IPC.workspaceInfo, () => {
    const dir = loadSettings(settingsDir()).workspaceDir;
    return { dir, exists: existsSync(dir) };
  });
  ipcMain.handle(IPC.workspaceChoose, async () => {
    const opts = {
      title: mt(uiLang(), 'Рабочая папка RegWatch', 'RegWatch working folder'),
      defaultPath: loadSettings(settingsDir()).workspaceDir,
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const dir = r.filePaths[0];
    if (r.canceled || !dir) return null;
    const res = updateSettings(settingsDir(), { workspaceDir: dir });
    if (!res.ok) {
      dialog.showErrorBox(mt(uiLang(), 'Эту папку выбрать нельзя', 'This folder cannot be chosen'), Object.values(res.errors).join('\n'));
      return null;
    }
    prepareWorkspace(res.settings.workspaceDir);
    return res.settings.workspaceDir;
  });
  ipcMain.handle(IPC.workspaceOpenInFinder, async () => {
    const dir = loadSettings(settingsDir()).workspaceDir;
    const err = await shell.openPath(dir);
    if (err) dialog.showErrorBox(mt(uiLang(), 'Не удалось открыть папку', 'Could not open the folder'), err);
  });
  // «История» (ARC-03, VER-04) и эталоны из приложения (HAL-07). Аргументы из окна не доверяем: типы и длины
  // проверяются здесь, id прогона и код страны — по шаблонам и realpath внутри рабочей папки (history.ts).
  const ws = (): string => loadSettings(settingsDir()).workspaceDir;
  const shortStr = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined);
  ipcMain.handle(IPC.historyList, () => listHistoryRuns(ws()));
  ipcMain.handle(IPC.historyCountry, (_e, runId: unknown, code: unknown) => {
    const r = shortStr(runId, 40);
    const c = shortStr(code, 2);
    if (!r || !c) return null;
    return getCountryRun(ws(), r, c, uiLang());
  });
  ipcMain.handle(IPC.historyOpen, async (_e, runId: unknown, code: unknown) => {
    const L = uiLang();
    const r = shortStr(runId, 40);
    const c = code === undefined || code === null ? undefined : shortStr(code, 2);
    if (!r || (code !== undefined && code !== null && !c)) return { ok: false, error: mt(L, 'Неверный прогон или страна.', 'Invalid run or country.') };
    const t = resolveOpenTarget(ws(), r, c);
    if (!t.ok) {
      const error =
        t.reason === 'not_found'
          ? mt(L, 'Папки этого прогона нет в рабочей папке.', 'This run folder is not in the working folder.')
          : t.reason === 'outside'
            ? mt(L, 'Папка находится вне рабочей папки — открыть нельзя.', 'The folder is outside the working folder — it cannot be opened.')
            : mt(L, 'Неверный прогон или страна.', 'Invalid run or country.');
      return { ok: false, error };
    }
    // openPath открывает саму папку в Finder (showItemInFolder показал бы её внутри родительской).
    const err = await shell.openPath(t.path);
    return err ? { ok: false, error: mt(L, `Не удалось открыть папку: ${err}`, `Could not open the folder: ${err}`) } : { ok: true };
  });
  ipcMain.handle(IPC.historyAddCase, (_e, input: unknown) => {
    const L = uiLang();
    const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const kind = i['kind'] === 'false_positive' || i['kind'] === 'missed' ? i['kind'] : undefined;
    const runId = shortStr(i['runId'], 40);
    const country = shortStr(i['country'], 2);
    if (!kind || !runId || !country) return { ok: false, error: mt(L, 'Неверные данные случая.', 'Invalid case data.') };
    // Длинный комментарий не обрезаем молча: на 1 знак больше предела — addGoldenCase ответит понятной ошибкой.
    const comment = typeof i['comment'] === 'string' ? i['comment'].slice(0, COMMENT_MAX + 1) : '';
    const candidateId = shortStr(i['candidateId'], CANDIDATE_ID_MAX);
    const url = typeof i['url'] === 'string' ? i['url'].slice(0, URL_MAX + 1) : undefined;
    return addGoldenCase(ws(), { kind, runId, country, comment, ...(candidateId ? { candidateId } : {}), ...(url !== undefined ? { url } : {}) }, new Date(), L);
  });
  ipcMain.handle(IPC.historyCases, () => listGoldenCases(ws()));
  ipcMain.handle(IPC.secretsStatus, () => ({ mailPasswordSet: hasSecret('mailPassword') }));
  ipcMain.handle(IPC.secretsSetMailPassword, (_e, password: unknown) => {
    if (typeof password !== 'string') throw new Error(mt(uiLang(), 'Пароль должен быть строкой', 'The password must be a string'));
    setSecret('mailPassword', password);
    // Новый пароль — почту нужно проверить заново тестовым письмом.
    invalidateMailVerification(settingsDir());
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('before-quit', () => {
    quitting = true;
    scheduler.stop();
    autoResume.cancel();
    setPauseAwake(false);
    clearInterval(outboxTimer);
  });
  // Приложение живёт в трее, даже когда окон нет.
  app.on('window-all-closed', () => {});

  void app.whenReady().then(() => {
    registerIpc();
    const settings = loadSettings(settingsDir());
    // RUN-04: автозапуск при входе — по сохранённой настройке при каждом старте (и при её смене, см. registerIpc).
    applyLoginItem(settings.launchAtLogin);
    // Окно и значок — первыми: подготовка папки может ждать ответа macOS и не должна давать пустой экран.
    createTray();
    createWindow();
    const ready = prepareWorkspace(settings.workspaceDir);
    orchestrator = createOrchestrator();
    runController.notify();
    if (ready) void resumeUnfinished();
    // Расписания: сразу (догон, если приложение было закрыто), затем каждые 30 с и при пробуждении Mac.
    scheduler.start();
    powerMonitor.on('resume', () => void scheduler.tick());
    // Пауза по лимиту: после сна срок пересчитывается по настенным часам (если пора — продолжить сразу).
    powerMonitor.on('resume', () => autoResume.onWake());
    // Очередь писем: сразу (неотправленное до закрытия приложения), затем раз в минуту и при пробуждении.
    if (ready) void tickOutbox();
    outboxTimer = setInterval(() => void tickOutbox(), 60_000);
    powerMonitor.on('resume', () => void tickOutbox());
    // Прогон закончился — следующее расписание из очереди, не дожидаясь шага таймера.
    runController.onChange(() => {
      if (!orchestrator?.running) scheduler.kick();
    });
    app.on('activate', () => showWindow());
  });
}
