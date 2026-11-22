#!/usr/bin/env node
// Повтор прогона на СОХРАНЁННЫХ данных (вариант B, план «Проверка (шаг 4)»): новый конвейер
// (классы органов → отбор → экран по тексту → разбор только существенного → проверка → письмо) без нового сбора.
//
// Оригинал (по умолчанию ~/RegWatch/runs/2026-11-18_1517/UZ) только читается. Всё пишется в новую рабочую папку
// (по умолчанию <tmp>/regwatch-replay-<время>): копия candidates.json, снимков актов, настроек и стран, пустая runs/.
// Прогон идёт через настоящий Orchestrator и боевые исполнители (createStageExecutors + runStage) — как в приложении.
//
// Сеть: код НЕ качает страницы заново — фетчер-заглушка отдаёт сохранённые HTML. Настоящий фетчер получает ТОЛЬКО
// PDF актов без текста (--pdf-ids, по умолчанию 4 акта lex.uz), 1 запрос на акт, без повторов, с паузой.
// Модель на этапах анализа и проверки может открывать lex.uz/cbu.uz (WebFetch), как в приложении.
//
//   node scripts/replay.mjs --offline                   без модели и сети: классы органов и решения кода по снимкам
//   node scripts/replay.mjs --probe                     только проверка 5-часового окна (1 дешёвый вызов haiku)
//   node scripts/replay.mjs                             живой прогон (сначала проверка окна; ≥ 90 % — стоп)
//   node scripts/replay.mjs --triage live               отбор заново моделью (по умолчанию — решения из triage.json)
//   node scripts/replay.mjs --report <папка повтора>    отчёт и письмо по уже сделанному повтору (без модели)
//   node scripts/replay.mjs --resume <папка повтора>    продолжить прерванный повтор (пауза по лимиту, остановка)
//   ключи: --src <папка страны прогона> --out <новая рабочая папка> --max-usd 8 --pdf-ids a,b,c
//
// Код выхода: 0 — критерии выполнены; 1 — нет; 2 — окно заполнено / нет claude / прогон не завершён.
import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { actDir, safeActId } from '../src/main/archive.ts';
import { classifyIssuer, issuerRulesFor } from '../src/main/collect/issuer-class.ts';
import { createFetcher } from '../src/main/collect/fetcher.ts';
import { lexuzPdfUrl } from '../src/main/collect/adapters/lexuz.ts';
import { loadCountries } from '../src/main/countries/store.ts';
import { buildClaudeEnv, findClaude } from '../src/main/env.ts';
import { processOf } from '../src/main/golden.ts';
import { parseRateLimitEvent, runStage as realRunStage } from '../src/main/runner/claude-runner.ts';
import { createStageExecutors } from '../src/main/runner/executors.ts';
import { Orchestrator, loadRunReport } from '../src/main/runner/orchestrator.ts';
import { loadRun } from '../src/main/runner/run-state.ts';
import { routeCandidate } from '../src/main/runner/screen.ts';
import { loadSettings } from '../src/main/settings/store.ts';
import { ensureWorkspace } from '../src/main/workspace.ts';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const SRC = resolve(opt('src') ?? join(homedir(), 'RegWatch', 'runs', '2026-11-18_1517', 'UZ'));
const SRC_RUN = resolve(SRC, '..');
const CODE = SRC.split('/').pop();
const USER_CONFIG = join(homedir(), 'Library', 'Application Support', 'RegWatch');
const USER_WS = resolve(SRC_RUN, '..', '..');
const MAX_USD = Number(opt('max-usd') ?? 8);
const TRIAGE_MODE = opt('triage') ?? 'saved';
/** Порог окна перед стартом (доля 5-часового лимита). */
const PROBE_STOP = 0.9;
const PDF_IDS = (opt('pdf-ids') ?? 'lexuz-8594974,lexuz-8583679,lexuz-8587062,lexuz-8589382').split(',').filter(Boolean);
const PDF_PAUSE_MS = 4000;

/** Критерии приёмки (план, шаг 4). */
const KEY_ACTS = [
  ['lexuz-8530799', '24/2 (рег. 3254-2), корп. управление в банках'],
  ['lexuz-8554315', '22/4, платёжный коммутатор'],
  ['lexuz-8594974', '3976, санация (оздоровление) банков'],
  ['lexuz-8546900', '25/2, регулятивная песочница ЦБ'],
  ['lexuz-8587149', '26/8, взносы в фонд гарантирования вкладов'],
  ['lexuz-8554432', '№ 27, раскрытие информации эмитентами'],
];
const NOISE_ACTS = [
  ['lexuz-8537099', 'межд. договор (наркотики)'],
  ['lexuz-8543784', 'почтовая связь'],
  ['lexuz-8571898', 'здравоохранение'],
  ['lexuz-8577858', 'экспортные квоты'],
  ['lexuz-8545680', 'пилот деклараций'],
  ['cbu.uz-0dee86f9d098', 'перенос заседания ЦБ'],
];

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const readJsonOr = (f, d) => {
  try {
    return readJson(f);
  } catch {
    return d;
  }
};
const readLog = (f) =>
  existsSync(f)
    ? readFileSync(f, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];
const pct = (x) => (typeof x === 'number' ? `${(x * 100).toFixed(0)} %` : '—');
const usd = (x) => `$${x.toFixed(2)}`;
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} млн` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} тыс.` : String(n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

// ─────────────────────────── Рабочая папка повтора ───────────────────────────

/** Новая рабочая папка: скиллы, копии настроек/стран/watched.json, пустая runs/. Оригинал не меняется. */
function prepareWorkspace(ws) {
  mkdirSync(ws, { recursive: true });
  const real = realpathSync(ws);
  const hash = ensureWorkspace({ dir: real, skillsSrc: join(ROOT, 'skills'), goldenSrc: join(ROOT, 'docs', 'golden') }).skillsHash;
  const cfg = join(real, 'config');
  mkdirSync(cfg, { recursive: true });
  for (const f of ['settings.json', 'countries.json']) {
    if (!existsSync(join(cfg, f))) copyFileSync(join(USER_CONFIG, f), join(cfg, f));
  }
  // Известные редакции отслеживаемых актов — чтобы проверка не приняла старые редакции за новые.
  const watched = join(USER_WS, 'state', 'watched.json');
  if (existsSync(watched) && !existsSync(join(real, 'state', 'watched.json'))) copyFileSync(watched, join(real, 'state', 'watched.json'));
  return { ws: real, cfg, skillsHash: hash };
}

function replaySettings(cfg, ws) {
  const s = loadSettings(cfg); // читает КОПИЮ настроек (миграция пишет только в копию)
  return {
    ...s,
    workspaceDir: ws,
    // Новости в исходном прогоне дали 0 наводок; повтор их не запускает (без нового сбора).
    newsEnabled: false,
    advanced: { ...s.advanced, saveTranscripts: true },
  };
}

function replayCountry(cfg) {
  const c = loadCountries(cfg).find((x) => x.code === CODE);
  if (!c) throw new Error(`В копии countries.json нет страны ${CODE}`);
  return { ...c, active: true };
}

/** Снимки актов из оригинала → папка акта нового прогона (кроме актов, которым нужен PDF: их снимок снимается заново). */
function copySnapshots(cdir, ids) {
  let copied = 0;
  for (const id of ids) {
    if (PDF_IDS.includes(id)) continue;
    const from = join(SRC, 'acts', safeActId(id));
    if (!existsSync(join(from, 'snapshot.html')) || !existsSync(join(from, 'snapshot.txt'))) continue;
    const to = join(cdir, 'acts', safeActId(id));
    mkdirSync(to, { recursive: true });
    for (const f of ['snapshot.html', 'snapshot.txt', 'snapshot.json', 'snapshot.pdf']) {
      if (existsSync(join(from, f))) copyFileSync(join(from, f), join(to, f));
    }
    if (existsSync(join(from, 'related'))) cpSync(join(from, 'related'), join(to, 'related'), { recursive: true });
    copied++;
  }
  return copied;
}

// ─────────────────────────── Фетчер повтора ───────────────────────────

const normUrl = (u) => {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}${x.search}`;
  } catch {
    return u;
  }
};

/**
 * Страница акта — из сохранённого снимка оригинала; PDF актов из PDF_IDS — настоящим фетчером (1 запрос, пауза);
 * всё остальное — отказ (и запись в misses): повтор не собирает заново.
 */
function replayFetcher(candidates, { network }) {
  const byUrl = new Map();
  const pdfAllowed = new Map();
  for (const c of candidates) {
    const f = join(SRC, 'acts', safeActId(c.id), 'snapshot.html');
    if (existsSync(f)) byUrl.set(normUrl(c.url), f);
    if (PDF_IDS.includes(c.id)) {
      const p = lexuzPdfUrl(c.url);
      if (p) pdfAllowed.set(normUrl(p), c.id);
    }
  }
  const real = createFetcher({ retries: 0, perDomainDelayMs: PDF_PAUSE_MS, timeoutMs: 60_000 });
  const served = [];
  const misses = [];
  const pdf = [];
  let lastPdf = 0;
  const get = async (url, o) => {
    const n = normUrl(url);
    if (pdfAllowed.has(n)) {
      if (!network) {
        misses.push(url);
        return { ok: false, kind: 'network', message: 'офлайн-режим повтора: PDF не скачивается' };
      }
      if (pdf.some((p) => p.url === url)) return { ok: false, kind: 'http', status: 429, message: 'повтор: PDF этого акта уже запрашивался' };
      const wait = lastPdf + PDF_PAUSE_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastPdf = Date.now();
      const r = await real.get(url, o);
      pdf.push({ id: pdfAllowed.get(n), url, ok: r.ok, status: r.ok ? r.status : r.status ?? r.kind, bytes: r.ok ? (r.bytes?.length ?? r.body.length) : 0, contentType: r.ok ? r.contentType : '', message: r.ok ? '' : r.message });
      return r;
    }
    const file = byUrl.get(n);
    if (file) {
      served.push(url);
      return { ok: true, status: 200, url, body: readFileSync(file, 'utf8'), contentType: 'text/html; charset=utf-8' };
    }
    misses.push(url);
    return { ok: false, kind: 'http', status: 404, message: `повтор не ходит в сеть: адреса ${url} нет среди сохранённых снимков` };
  };
  return {
    served,
    misses,
    pdf,
    get,
    async postForm(url) {
      misses.push(`POST ${url}`);
      return { ok: false, kind: 'http', status: 404, message: `повтор не ходит в сеть: POST ${url}` };
    },
  };
}

// ─────────────────────────── Проверка окна (1 вызов haiku) ───────────────────────────

/** Дешёвый вызов haiku: читает rate_limit_event (5-часовое окно). Без инструментов, без навыков проекта. */
async function probeWindow(bin, env, cwd) {
  const argv = [
    '-p', 'Reply with OK',
    '--model', 'haiku',
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'dontAsk',
    '--tools', '',
    '--disallowedTools', 'Bash', 'Agent', 'Task', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--max-turns', '1',
  ];
  return new Promise((res) => {
    const ch = spawn(bin, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => ch.kill('SIGKILL'), 120_000);
    ch.stdout.on('data', (d) => (out += d));
    ch.stderr.on('data', (d) => (err += d));
    ch.on('close', (code) => {
      clearTimeout(timer);
      let rl = null;
      let cost = 0;
      let seven = null;
      for (const line of out.split('\n')) {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.type === 'rate_limit_event') {
          rl = parseRateLimitEvent(e);
          const w = e.rate_limit_info?.unifiedWindows ?? {};
          for (const [name, v] of Object.entries(w)) if (name !== 'five_hour' && typeof v?.utilization === 'number') seven = { name, utilization: v.utilization };
        }
        if (e.type === 'result') cost = e.total_cost_usd ?? 0;
      }
      res({ code, rl, cost, seven, err: err.trim().split('\n')[0] ?? '' });
    });
  });
}

// ─────────────────────────── Отчёт ───────────────────────────

/** Расход по этапам из log.jsonl (события `process`). */
function stageUsage(log) {
  const m = new Map();
  for (const r of log) {
    if (r.event !== 'process') continue;
    const key = `${r.stage}|${r.model}`;
    const a = m.get(key) ?? { stage: r.stage, model: r.model, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, fails: 0 };
    a.calls++;
    a.input += r.tokens?.input ?? 0;
    a.output += r.tokens?.output ?? 0;
    a.cacheRead += r.tokens?.cache_read ?? 0;
    a.cacheWrite += r.tokens?.cache_write ?? 0;
    a.usd += r.tokens?.cost_usd ?? 0;
    if (r.failure) a.fails++;
    m.set(key, a);
  }
  return [...m.values()];
}

const STAGE_ORDER = ['news', 'triage', 'screen', 'confirm', 'analyze', 'verify'];
const STAGE_RU = { news: 'Новости', triage: 'Отбор', screen: 'Экран', confirm: 'Перепроверка экрана', analyze: 'Анализ', verify: 'Проверка' };

function funnelOld() {
  const log = readLog(join(SRC, 'log.jsonl'));
  const tri = readJson(join(SRC, 'triage.json')).items;
  const count = (d) => tri.filter((i) => i.decision === d).length;
  const analyzed = new Set(log.filter((r) => r.event === 'act_done').map((r) => r.act));
  const verified = log.filter((r) => r.event === 'verify_card').length;
  const res = readJsonOr(join(SRC, 'result.json'), { items: [] });
  return {
    log,
    candidates: readJson(join(SRC, 'candidates.json')).candidates.length,
    triage: `relevant ${count('relevant')} / borderline ${count('borderline')} / irrelevant ${count('irrelevant')}`,
    screen: '— (этапа не было)',
    analyze: `${analyzed.size} актов (${log.filter((r) => r.event === 'act_done').length} карточек с учётом 2-го круга)`,
    verify: `${verified} проверок карточек`,
    result: `items ${res.items.length}`,
  };
}

function funnelNew(cdir, state) {
  const log = readLog(join(cdir, 'log.jsonl'));
  const tri = readJsonOr(join(cdir, 'triage.json'), { items: [] }).items;
  const count = (d) => tri.filter((i) => i.decision === d).length;
  const c = state.countries[CODE] ?? {};
  const scr = Object.values(c.screen ?? {});
  const by = (f, b) => scr.filter((s) => s.final === f && (!b || s.by === b)).length;
  const analyzed = new Set(log.filter((r) => r.event === 'act_done').map((r) => r.act));
  const res = readJsonOr(join(cdir, 'result.json'), { items: [], for_information: [], unverified: [] });
  return {
    log,
    candidates: readJsonOr(join(cdir, 'candidates.json'), { candidates: [] }).candidates.length,
    triage: `relevant ${count('relevant')} / borderline ${count('borderline')} / irrelevant ${count('irrelevant')}`,
    screen:
      `${scr.length} на экран: код — нет текста ${by('no_text', 'code')}, шум ${by('dropped', 'code')}; ` +
      `модель — material ${by('material', 'screen') + by('material', 'confirm')}, minor ${by('minor', 'screen') + by('minor', 'confirm')}, ` +
      `dropped ${by('dropped', 'screen') + by('dropped', 'confirm')} (из них после перепроверки ${scr.filter((s) => s.by === 'confirm').length})`,
    analyze: `${analyzed.size} актов (${log.filter((r) => r.event === 'act_done').length} карточек с учётом 2-го круга)`,
    verify: `${log.filter((r) => r.event === 'verify_card').length} проверок карточек`,
    result: `items ${res.items.length}, for_information ${(res.for_information ?? []).length}, unverified ${(res.unverified ?? []).length}`,
  };
}

function usageTable(oldU, newU) {
  const rows = [];
  rows.push('| Этап | Было: вызовов · модель | Было: out / кэш чт. / кэш зап. | Было $ | Стало: вызовов · модель | Стало: out / кэш чт. / кэш зап. | Стало $ |');
  rows.push('|---|---|---|---|---|---|---|');
  const fmt = (list) =>
    list.length
      ? [
          list.map((a) => `${a.calls}${a.fails ? ` (сбоев ${a.fails})` : ''} · ${a.model}`).join(', '),
          list.map((a) => `${k(a.output)} / ${k(a.cacheRead)} / ${k(a.cacheWrite)}`).join(', '),
          usd(list.reduce((s, a) => s + a.usd, 0)),
        ]
      : ['0', '—', '$0.00'];
  for (const st of STAGE_ORDER) {
    const o = oldU.filter((a) => a.stage === st);
    const n = newU.filter((a) => a.stage === st);
    if (!o.length && !n.length) continue;
    rows.push(`| ${STAGE_RU[st]} | ${fmt(o).join(' | ')} | ${fmt(n).join(' | ')} |`);
  }
  const tot = (u) => [u.reduce((s, a) => s + a.calls, 0), u.reduce((s, a) => s + a.output, 0), u.reduce((s, a) => s + a.usd, 0)];
  const [oc, oo, ou] = tot(oldU);
  const [nc, no, nu] = tot(newU);
  rows.push(`| **Итого** | ${oc} | out ${k(oo)} | **${usd(ou)}** | ${nc} | out ${k(no)} | **${usd(nu)}** |`);
  return { text: rows.join('\n'), oldUsd: ou, newUsd: nu };
}

/** Где оказался акт в итоге повтора. */
function placeOf(id, res, state) {
  const c = state.countries[CODE] ?? {};
  const it = res.items.find((x) => x.candidate_id === id);
  if (it) return { where: 'items', text: `существенные (${it.confirmed ? 'подтверждено' : `⚠ не подтверждено: ${it.disputed_fields.join(', ')}`})` };
  if ((res.for_information ?? []).some((x) => x.candidate_id === id)) return { where: 'for_information', text: 'для сведения' };
  if ((res.unverified ?? []).some((x) => x.candidate_id === id)) return { where: 'unverified', text: '⚠ не удалось проверить' };
  // Прогон не завершён (нет result.json): где акт сейчас и куда он идёт.
  const a = c.acts?.[id];
  if (a && !state.__finished) {
    return { where: 'pending_card', text: `карточка есть, проверка не завершена (разбор ${a.analyze}, кругов ${a.rounds}, вердикт ${a.verdict ?? '—'}) → пойдёт в письмо` };
  }
  const s = c.screen?.[id];
  if (s) return { where: s.final ?? 'pending', text: `экран: ${s.final ?? 'не завершён'} (${s.by ?? '—'}) — ${s.reason ?? ''}` };
  const tri = readJsonOr(join(state.__cdir, 'triage.json'), { items: [] }).items.find((x) => x.id === id);
  if (tri?.decision === 'irrelevant') return { where: 'triage_irrelevant', text: `отбор: irrelevant (${tri.reason_code ?? '—'}) — ${tri.reason_text}` };
  return { where: 'nowhere', text: 'нигде (не дошёл до экрана)' };
}

function report(ws, extra = {}) {
  const runsDir = join(ws, 'runs');
  const runId = readdirSync(runsDir).filter((d) => statSync(join(runsDir, d)).isDirectory()).sort().pop();
  if (!runId) throw new Error(`В ${runsDir} нет прогона`);
  const rdir = join(runsDir, runId);
  const cdir = join(rdir, CODE);
  const state = loadRun(rdir);
  state.__cdir = cdir;
  state.__finished = existsSync(join(cdir, 'result.json'));
  const out = [];
  const say = (s = '') => out.push(s);

  const old = funnelOld();
  const neu = funnelNew(cdir, state);
  const oldU = stageUsage(old.log);
  const newU = stageUsage(neu.log);
  const tbl = usageTable(oldU, newU);

  say(`# Повтор прогона ${SRC_RUN.split('/').pop()}/${CODE} → ${rdir}`);
  say(`Статус страны: ${state.countries[CODE]?.status ?? '—'}${state.paused_until ? `; пауза до ${state.paused_until}` : ''}${state.stopped ? '; остановлен' : ''}`);
  say('');
  say('## Расход: было / стало');
  say(tbl.text);
  say('');
  say('## Воронка: было / стало');
  say('| Шаг | Было | Стало |');
  say('|---|---|---|');
  for (const [name, key] of [
    ['Кандидатов', 'candidates'],
    ['Отбор', 'triage'],
    ['Экран по тексту', 'screen'],
    ['Полный разбор', 'analyze'],
    ['Проверка', 'verify'],
    ['Итог (result.json)', 'result'],
  ]) say(`| ${name} | ${old[key]} | ${neu[key]} |`);
  say('');

  // Окно лимита
  const fives = newU.length ? neu.log.filter((r) => r.event === 'process') : [];
  if (extra.probe || extra.windows?.length) {
    const w = extra.windows ?? [];
    say(`5-часовое окно: до запуска ${pct(extra.probe?.rl?.info?.utilization)}; по ходу ${w.length ? `${pct(w[0])} → ${pct(w.at(-1))}` : '—'}${extra.probe?.seven ? `; ${extra.probe.seven.name} ${pct(extra.probe.seven.utilization)} до запуска` : ''}`);
  }
  say(`Оценка доли 5-часового лимита по факту FINDINGS (≈ 11 % на $1 работы sonnet): ≈ ${(tbl.newUsd * 11).toFixed(0)} % (было ≈ ${(tbl.oldUsd * 11).toFixed(0)} %)`);
  if (fives.length === 0) say('Новых вызовов модели нет.');
  say('');

  // Акты на экране
  const cands = readJsonOr(join(cdir, 'candidates.json'), { candidates: [] }).candidates;
  const cById = new Map(cands.map((c) => [c.id, c]));
  const c = state.countries[CODE] ?? {};
  const res = readJsonOr(join(cdir, 'result.json'), { items: [], for_information: [], unverified: [] });
  say('## Решения экрана');
  say('| id | орган | класс | терминов | решение | кто | причина | итог |');
  say('|---|---|---|---|---|---|---|---|');
  const screenIds = Object.keys(c.screen ?? {});
  const direct = Object.keys(c.acts ?? {}).filter((id) => !screenIds.includes(id));
  for (const id of [...direct, ...screenIds]) {
    const s = c.screen?.[id];
    const cand = cById.get(id);
    const p = placeOf(id, res, state);
    say(
      `| ${id} | ${(cand?.issuer || '—').slice(0, 45)} | ${cand?.issuerClass ?? '—'} | ${s?.term_count ?? '—'} | ${s ? (s.final ?? 'pending') : `канал ${cand?.channel ?? '?'} → разбор`} | ${s?.by ?? 'код'} | ${(s?.reason ?? '').replace(/\|/g, '/').slice(0, 160)} | ${p.where} |`,
    );
  }
  say('');

  // Критерии
  let ok = true;
  say('## Критерии приёмки');
  if (!state.__finished) {
    ok = false;
    say('⏳ Прогон не завершён (нет result.json): ниже — прогноз по текущему состоянию; ⏳ — дошёл до карточки/экрана, итог после --resume.');
  }
  // Прогноз для незавершённого прогона: карточка → письмо; minor → «для сведения»; no_text → «не удалось проверить».
  const bound = (w) => (w === 'pending_card' || w === 'material' ? 'items' : w === 'minor' ? 'for_information' : w === 'no_text' ? 'unverified' : w);
  for (const [id, name] of KEY_ACTS) {
    const p = placeOf(id, res, state);
    const pass = ['items', 'for_information', 'unverified'].includes(bound(p.where));
    if (!pass) ok = false;
    say(`${pass ? (state.__finished ? '✅' : '⏳') : '❌'} ${name} (${id}): ${p.text}`);
  }
  for (const [id, name] of NOISE_ACTS) {
    const p0 = placeOf(id, res, state);
    const p = { ...p0, where: bound(p0.where) };
    let mark = '✅';
    let note = '';
    if (p.where === 'items' || p.where === 'for_information') {
      mark = '❌';
      ok = false;
    } else if (p.where === 'unverified') {
      const txt = join(cdir, 'acts', safeActId(id), 'snapshot.txt');
      const len = existsSync(txt) ? readFileSync(txt, 'utf8').length : 0;
      mark = len >= 400 ? '❌' : '⚠';
      if (len >= 400) ok = false;
      note = ` — текст в снимке ${len} знаков${len >= 400 ? ' (текст ЕСТЬ: no_text для шума недопустим)' : ' (текста действительно нет)'}`;
    }
    say(`${mark} шум «${name}» (${id}): ${p.text}${note}`);
  }
  const budgetOk = tbl.newUsd <= 3;
  say(`${budgetOk ? '✅' : '❌'} расход ≤ $3: ${usd(tbl.newUsd)}`);
  if (!budgetOk) ok = false;
  say('');

  // PDF и сеть
  const pdfLog = neu.log.filter((r) => r.event === 'replay_pdf');
  if (pdfLog.length) {
    say('## PDF (настоящая сеть)');
    for (const r of pdfLog) say(`- ${r.id}: ${r.ok ? `HTTP ${r.status}, ${r.bytes} байт, ${r.contentType}` : `сбой: ${r.message}`}`);
  }
  for (const id of PDF_IDS) {
    const meta = readJsonOr(join(cdir, 'acts', safeActId(id), 'snapshot.json'), null);
    const txt = join(cdir, 'acts', safeActId(id), 'snapshot.txt');
    const len = existsSync(txt) ? readFileSync(txt, 'utf8').length : 0;
    if (meta) say(`- ${id}: текст ${len} знаков; PDF ${meta.pdf ? (meta.pdf.ok ? `прочитан, страниц ${meta.pdf.pages}${meta.pdf.truncated ? ', обрезан' : ''}` : `не прочитан — ${meta.pdf.message}`) : 'не пробовали'}`);
  }
  const misses = neu.log.filter((r) => r.event === 'replay_network_miss');
  if (misses.length) say(`Код пытался скачать мимо снимков: ${misses.map((r) => r.url).join(', ')}`);
  say('');

  // Письмо
  say('## Письмо');
  const digestPath = join(ROOT, 'src', 'main', 'digest', 'build.ts');
  return { out, ok, digestPath, rdir, state, budgetUsd: tbl.newUsd };
}

async function printDigest(r) {
  const lines = r.out;
  if (!existsSync(r.digestPath)) {
    lines.push('src/main/digest/build.ts нет — письмо не собрано; result.json:');
    lines.push(readFileSync(join(r.rdir, CODE, 'result.json'), 'utf8'));
    return;
  }
  const { buildDigest } = await import('../src/main/digest/build.ts');
  const rep = loadRunReport(r.rdir, r.state);
  const countries = rep.countries.map((c) => {
    const { cards, ...result } = c;
    return { code: c.country, nameRu: c.country === 'UZ' ? 'Узбекистан' : c.country, flag: c.country === 'UZ' ? '🇺🇿' : undefined, result, cards };
  });
  const ok = rep.countries.filter((c) => !String(c.status).startsWith('failed')).length;
  const d = buildDigest({
    runId: r.state.id,
    date: r.state.started_at,
    countries,
    checked: { ok, total: rep.countries.length },
    failures: rep.countries.filter((c) => String(c.status).startsWith('failed')).map((c) => ({ code: c.country, nameRu: c.country, reason: c.error ?? c.status })),
  });
  writeFileSync(join(r.rdir, 'digest.txt'), `Тема: ${d.subject}\n\n${d.text}`);
  writeFileSync(join(r.rdir, 'digest.html'), d.html);
  lines.push(`Тема: ${d.subject}`);
  lines.push('```');
  lines.push(d.text.trimEnd());
  lines.push('```');
  lines.push(`(также ${join(r.rdir, 'digest.txt')} и digest.html)`);
}

async function finishReport(ws, extra) {
  const r = report(ws, extra);
  await printDigest(r);
  const text = r.out.join('\n');
  writeFileSync(join(r.rdir, 'replay-report.md'), text + '\n');
  console.log(text);
  console.log(`\nОтчёт: ${join(r.rdir, 'replay-report.md')}`);
  return r;
}

// ─────────────────────────── Режимы ───────────────────────────

if (flag('report')) {
  const ws = resolve(opt('report'));
  const extra = readJsonOr(join(ws, 'replay-extra.json'), {});
  const r = await finishReport(ws, extra);
  process.exit(r.ok ? 0 : 1);
}

const srcCands = readJson(join(SRC, 'candidates.json'));
const savedTriage = readJson(join(SRC, 'triage.json'));
const resumeDir = opt('resume') ? resolve(opt('resume')) : null;
const wsPath = resumeDir ?? resolve(opt('out') ?? join(tmpdir(), `regwatch-replay-${stamp()}`));
const { ws, cfg, skillsHash } = prepareWorkspace(wsPath);
const settings = replaySettings(cfg, ws);
const country = replayCountry(cfg);
const rules = issuerRulesFor(country);
console.log(`Оригинал (только чтение): ${SRC}`);
console.log(`Рабочая папка повтора: ${ws}`);
console.log(`Пресет ${settings.preset}; отбор: ${TRIAGE_MODE === 'live' ? 'заново моделью' : 'решения из triage.json (0 токенов)'}; PDF: ${PDF_IDS.join(', ')}`);

// ── Офлайн: классы органов и решения кода, без модели и без сети ──
if (flag('offline')) {
  const fetcher = replayFetcher(srcCands.candidates, { network: false });
  const ex = createStageExecutors({ schemasDir: join(ROOT, 'schemas'), claudeBin: () => null, claudeEnv: () => ({}), fetcher, collector: { collect: async () => ({ ok: true, output: { candidates: [] } }) }, log: () => {} });
  const runId = 'offline';
  const cdir = join(ws, 'runs', runId, CODE);
  mkdirSync(cdir, { recursive: true });
  copySnapshots(cdir, srcCands.candidates.map((c) => c.id));
  const ctx = { runId, runDir: join(ws, 'runs', runId), workspaceDir: ws, countryDir: cdir, country, mode: 'dry_run', window: srcCands.window, settings };
  const dec = new Map(savedTriage.items.map((i) => [i.id, i]));
  console.log('\n| id | отбор | класс | орган | текст | терминов | решение кода |');
  console.log('|---|---|---|---|---|---|---|');
  for (const c0 of srcCands.candidates) {
    const c = { ...c0, issuerClass: classifyIssuer(rules, c0.issuer, c0.doc_type) };
    const t = dec.get(c.id);
    if (t?.decision === 'irrelevant' && ![...KEY_ACTS, ...NOISE_ACTS].some(([id]) => id === c.id)) continue;
    const r = await ex.prepareScreen(ctx, c);
    const route = routeCandidate(c, r.ok ? r.prep : null, r.ok ? undefined : r.message);
    console.log(`| ${c.id} | ${t?.decision} | ${c.issuerClass} | ${(c.issuer || '—').slice(0, 40)} | ${r.ok ? r.prep.textSource : 'сбой'} | ${r.ok ? r.prep.termCount : '—'} | ${route.kind}${route.reason ? `: ${route.reason}` : ''} |`);
  }
  console.log(`\nСеть (должно быть пусто, кроме PDF): ${fetcher.misses.join(', ') || 'нет'}`);
  process.exit(0);
}

// ── Живой прогон ──
const env = await buildClaudeEnv();
const bin = findClaude({ env, ...(settings.advanced?.claudePath ? { configured: settings.advanced.claudePath } : {}) });
if (!bin) {
  console.log('❌ Claude Code не найден');
  process.exit(2);
}

console.log('\nПроверка 5-часового окна (1 вызов haiku)…');
const probe = await probeWindow(bin, env, ws);
const util = probe.rl?.info?.utilization;
console.log(`  окно 5 ч: ${pct(util)}; статус ${probe.rl?.info?.status ?? '—'}; сброс ${probe.rl?.info?.resetsAt ?? '—'}${probe.seven ? `; ${probe.seven.name} ${pct(probe.seven.utilization)}` : ''}; $${probe.cost.toFixed(4)}${probe.code ? `; код выхода ${probe.code} ${probe.err}` : ''}`);
if (!probe.rl) console.log('  ⚠ rate_limit_event не пришёл — доля окна неизвестна');
if ((typeof util === 'number' && util >= PROBE_STOP) || probe.rl?.rejected) {
  console.log(`⏸ Окно заполнено (${pct(util)} ≥ ${pct(PROBE_STOP)}): повтор не запускается. Сброс: ${probe.rl?.resetsAt ?? probe.rl?.info?.resetsAt ?? 'неизвестно'}`);
  process.exit(2);
}
if (flag('probe')) process.exit(0);

const fetcher = replayFetcher(srcCands.candidates, { network: true });
const windows = [];
let spent = 0;
let orch;
let stopping = false;
const runStage = async (o) => {
  const r = await realRunStage(o);
  const p = processOf(o, r);
  spent += p.costUsd;
  if (typeof p.fiveHour === 'number') windows.push(p.fiveHour);
  console.log(
    `  [${new Date().toLocaleTimeString('ru-RU')}] ${p.stage} (${p.model}): ${p.ok ? 'ok' : `${p.failure}: ${p.message}`}; out ${p.outputTokens}, кэш ${k(p.cacheRead)}/${k(p.cacheWrite)}; $${p.costUsd.toFixed(3)}; всего $${spent.toFixed(2)}; окно ${pct(p.fiveHour)}`,
  );
  if (spent > MAX_USD && orch && !stopping) {
    stopping = true;
    console.log(`⛔ Расход $${spent.toFixed(2)} > --max-usd ${MAX_USD}: мягкая остановка после текущего шага`);
    orch.stop();
  }
  // Порог окна действует и по ходу прогона, а не только на старте: ≥ 90 % — мягкая остановка (продолжение — --resume).
  if (typeof p.fiveHour === 'number' && p.fiveHour >= PROBE_STOP && orch && !stopping) {
    stopping = true;
    console.log(`⏸ 5-часовое окно ${pct(p.fiveHour)} ≥ ${pct(PROBE_STOP)}: мягкая остановка после текущего шага. Сброс окна: ${probe.rl?.info?.resetsAt ?? 'неизвестно'}`);
    orch.stop();
  }
  return r;
};

const base = createStageExecutors({
  schemasDir: join(ROOT, 'schemas'),
  claudeBin: () => bin,
  claudeEnv: () => env,
  fetcher,
  collector: { collect: async () => ({ ok: false, failure: 'internal', message: 'не используется' }) },
  runStage,
});

const logTo = (ctx, event, text, data = {}) => {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), country: ctx.country.code, event, text, ...data });
    writeFileSync(join(ctx.countryDir, 'log.jsonl'), line + '\n', { flag: 'a' });
  } catch {
    /* журнал не роняет повтор */
  }
};

const executors = {
  ...base,
  /** «Сбор» = сохранённые кандидаты и снимки оригинала (0 запросов в сеть). */
  async collect(ctx) {
    const n = copySnapshots(ctx.countryDir, srcCands.candidates.map((c) => c.id));
    logTo(ctx, 'replay_collect', `Повтор: кандидатов ${srcCands.candidates.length} из ${SRC}; снимков скопировано ${n}; без снимка (PDF заново): ${PDF_IDS.join(', ')}`);
    return {
      ok: true,
      output: {
        candidates: srcCands.candidates.map(({ issuerClass: _c, ...c }) => c),
        sourceFailures: srcCands.source_failures ?? [],
        anomalies: [],
        sourceCounts: [],
      },
    };
  },
  /** Отбор: решения исходного triage.json как есть (0 токенов) или заново моделью (--triage live). */
  async triage(ctx, cands) {
    if (TRIAGE_MODE === 'live') return base.triage(ctx, cands);
    const byId = new Map(savedTriage.items.map((i) => [i.id, i]));
    const items = cands.map((c) => byId.get(c.id) ?? { id: c.id, decision: 'irrelevant', reason_code: 'other_sector', reason_text: 'not in saved triage.json', confidence: 'low' });
    logTo(ctx, 'replay_triage', `Повтор: решения отбора из ${join(SRC, 'triage.json')} (0 вызовов модели)`);
    return { ok: true, output: { country: ctx.country.code, items } };
  },
  /** Экран: как в приложении; после подготовки текста — журнал PDF и промахов сети. */
  async prepareScreen(ctx, cand) {
    const before = fetcher.pdf.length;
    const missBefore = fetcher.misses.length;
    const r = await base.prepareScreen(ctx, cand);
    for (const p of fetcher.pdf.slice(before)) logTo(ctx, 'replay_pdf', `PDF ${p.id}: ${p.ok ? `${p.bytes} байт` : p.message}`, p);
    for (const u of fetcher.misses.slice(missBefore)) logTo(ctx, 'replay_network_miss', `Повтор: запрос мимо снимков ${u}`, { id: cand.id, url: u });
    return r;
  },
  async resolveLead(ctx, lead, known) {
    const missBefore = fetcher.misses.length;
    const r = await base.resolveLead(ctx, lead, known);
    for (const u of fetcher.misses.slice(missBefore)) logTo(ctx, 'replay_network_miss', `Повтор: запрос мимо снимков ${u} (подсказка)`, { url: u });
    return r;
  },
};

orch = new Orchestrator({ executors, now: () => new Date() });
const t0 = Date.now();
let result;
if (resumeDir) {
  const runsDir = join(ws, 'runs');
  const runId = readdirSync(runsDir).filter((d) => statSync(join(runsDir, d)).isDirectory() && d !== 'offline').sort().pop();
  console.log(`\nПродолжение повтора ${runId}…`);
  result = await orch.resume({ countries: [country], settings, runDir: join(runsDir, runId) });
} else {
  console.log('\nПовтор: сбор (копия) → отбор → экран → разбор → проверка…');
  result = await orch.start({
    mode: 'dry_run',
    countries: [country],
    settings,
    gate: { canRun: false, canDryRun: true, message: '' },
    windowOverride: srcCands.window,
    skillsHash,
  });
}
console.log(`\nПрогон: ${result ? (result.ok ? result.end : `заблокирован: ${result.blocked}`) : 'продолжать нечего'}; ${((Date.now() - t0) / 60000).toFixed(1)} мин; $${spent.toFixed(2)}`);
const extra = { probe, windows };
writeFileSync(join(ws, 'replay-extra.json'), JSON.stringify(extra, null, 2));
if (!result?.ok || result.end !== 'finished') {
  console.log(`Повтор не завершён. Продолжить: node scripts/replay.mjs --resume ${ws}`);
  try {
    await finishReport(ws, extra);
  } catch (e) {
    console.log(`Отчёт по незавершённому повтору не собран: ${e.message}`);
  }
  process.exit(2);
}
const r = await finishReport(ws, extra);
process.exit(r.ok ? 0 : 1);
