#!/usr/bin/env node
// T-1 (docs/07) «Ретро-прогон UZ» на живом lex.uz и настоящей модели — с ограничением расхода.
//
//   (а) сбор (collector, без модели) — как scripts/collect-uz.mjs;
//   (б) настоящий отбор executors.triage по ВСЕМ кандидатам (пакеты по 40, sonnet по пресету balanced) + полнота;
//   (в) оба эталонных акта (рег. 3254-1 и 3254-2) среди кандидатов и отобраны (relevant|borderline);
//   (г) статистика отбора и ОЦЕНКА стоимости полного прогона (анализ всех отобранных не запускается);
//   (д) анализ + проверка цитат + verify ТОЛЬКО двух эталонных актов (opus); для 3254-2 — сравнение с эталоном.
//       Пропускается, если 5-часовое окно после отбора > 85%;
//   (е) итог по-русски.
//
//   node scripts/t1.mjs [--from 2026-07-01] [--to 2026-11-17] [--max-window 0.85]
//
// Рабочая папка — новая во временной папке (не ~/RegWatch), журнал отправленного не пишется (backfill).
// Код выхода: 0 — оба акта найдены и отобраны; 1 — нет; 2 — нет claude / лимит до конца отбора.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { actDir } from '../src/main/archive.ts';
import { accountingTotals, checkCompleteness, completenessFailure } from '../src/main/checks/completeness.ts';
import { createCollector } from '../src/main/collect/collector.ts';
import { createFetcher } from '../src/main/collect/fetcher.ts';
import { seedCountries } from '../src/main/countries/seed.ts';
import { buildClaudeEnv, findClaude } from '../src/main/env.ts';
import { writeJsonAtomic } from '../src/main/fs-atomic.ts';
import { compareCard, formatChecks, loadGoldenCases, processOf } from '../src/main/golden.ts';
import { runStage as realRunStage } from '../src/main/runner/claude-runner.ts';
import { TRIAGE_BATCH, createStageExecutors } from '../src/main/runner/executors.ts';
import { defaultSettings } from '../src/main/settings/defaults.ts';
import { PRESET_MODELS } from '../src/main/settings/presets.ts';
import { ensureWorkspace } from '../src/main/workspace.ts';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const from = opt('from', '2026-07-01');
const to = opt('to', '2026-11-17');
const MAX_WINDOW = Number(opt('max-window', '0.85'));

// Цены прошлых живых прогонов (FINDINGS «Фаза 5: T-2, T-6, T-16»): analyze opus $0.50–0.65, verify opus ≈ $0.65–0.76.
const PRICE = { analyzeLo: 0.5, analyzeHi: 0.65, verify: 0.65 };

const WANT = [
  { reg: '3254-1', label: 'пост. ЦБ № 19/8 от 08.07.2026, рег. 3254-1' },
  { reg: '3254-2', label: 'пост. ЦБ № 24/2 от 17.09.2026, рег. 3254-2' },
];

const t0 = Date.now();
const sec = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(4);
const say = (s) => console.log(`  [${sec()} с] ${s}`);
const pct = (x) => (typeof x === 'number' ? `${(x * 100).toFixed(0)}%` : '—');
const usd = (x) => `$${x.toFixed(3)}`;
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ── Окружение ──
const env = await buildClaudeEnv();
const bin = findClaude({ env });
if (!bin) {
  console.log('❌ Claude Code не найден — живой T-1 невозможен');
  process.exit(2);
}

const ws = realpathSync(mkdtempSync(join(tmpdir(), 'regwatch-t1-')));
const wsInfo = ensureWorkspace({ dir: ws, skillsSrc: join(ROOT, 'skills'), goldenSrc: join(ROOT, 'docs', 'golden') });
const settings = { ...defaultSettings(homedir()), workspaceDir: ws };
const uz = seedCountries().find((c) => c.code === 'UZ');
// PRM-04 (фаза 6): WebFetch анализа/проверки — только по проверенным источникам (✅/⚠). lex.uz и акты UZ подтверждены
// проверкой источников (T-10, FINDINGS «Фаза 6»), поэтому в этой временной копии они ✅.
for (const s of uz.sources) if (s.url.includes('lex.uz')) s.state = 'ok';
for (const a of uz.watchedActs) a.state = 'ok';
const runId = 't1-live';
const runDir = join(ws, 'runs', runId);
const countryDir = join(runDir, 'UZ');
mkdirSync(countryDir, { recursive: true });
const ctx = { runId, runDir, workspaceDir: ws, countryDir, country: uz, mode: 'backfill', window: { from, to }, settings };
const models = PRESET_MODELS[settings.preset];

console.log(`T-1 «Ретро-прогон UZ» (живой): окно ${from}…${to}, режим backfill, пресет ${settings.preset} (отбор ${models.triage}, анализ ${models.analyze}, проверка ${models.verify})`);
console.log(`claude: ${bin}; рабочая папка ${ws}; скиллы: ${wsInfo.skills.join(', ')} (sha256 ${wsInfo.skillsHash.slice(0, 12)})`);
console.log(`Тема: ${settings.topic.split('\n')[0].slice(0, 120)}… (по умолчанию); perspective по умолчанию`);

// ── Сеть: вежливые паузы ≥ 1 с, учёт запросов по шагам ──
const base = createFetcher();
let last = 0;
let phase = 'collect';
const reqs = []; // { phase, host, url }
const pause = async () => {
  const wait = last + 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
};
const fetcher = {
  async get(url, o) {
    await pause();
    reqs.push({ phase, host: new URL(url).hostname, url });
    try {
      return await base.get(url, o);
    } finally {
      last = Date.now();
    }
  },
  async postForm(url, f, o) {
    await pause();
    reqs.push({ phase, host: new URL(url).hostname, url });
    try {
      return await base.postForm(url, f, o);
    } finally {
      last = Date.now();
    }
  },
};

// ── Модель: учёт процессов и 5-часового окна ──
const procs = []; // processOf + phase
let lastWindow; // доля окна из последнего rate_limit_event
let limitHit = null;
const runStage = async (o) => {
  const r = await realRunStage(o);
  const p = { phase, ...processOf(o, r) };
  procs.push(p);
  if (typeof r.rateLimit?.utilization === 'number') lastWindow = r.rateLimit.utilization;
  if (!r.ok && r.failure === 'limit') limitHit = r.resetsAt ?? 'неизвестно';
  say(
    `процесс ${procs.length}: ${p.stage} (${p.model}) ${p.ok ? 'ok' : `${p.failure}: ${p.message}`}; ${usd(p.costUsd)}; ` +
      `ходов ${p.turns ?? '—'}; ${(p.durationMs / 1000).toFixed(0)} с; попыток ${p.attempts}; окно 5 ч ${pct(p.fiveHour)}` +
      `${p.denied?.length ? `; отказы: ${p.denied.join(', ')}` : ''}`,
  );
  return r;
};

const collectLog = [];
const collector = createCollector({
  fetcher,
  workspaceDir: ws,
  log: (_c, event, text) => {
    collectLog.push({ event, text });
    say(`${event}: ${text}`);
  },
});
const execLog = [];
const ex = createStageExecutors({
  schemasDir: join(ROOT, 'schemas'),
  claudeBin: () => bin,
  claudeEnv: () => env,
  fetcher,
  collector,
  runStage,
  log: (_c, event, text, data) => {
    execLog.push({ event, text, data });
    say(`${event}: ${text}`);
  },
});

const report = { window: { from, to }, workspace: ws, steps: {} };
const verdicts = []; // { ok, text }
const mark = (ok, text) => verdicts.push({ ok, text });

// ═════════ (а) сбор ═════════
console.log('\n(а) Сбор (collector, без модели)…');
const col = await ex.collect(ctx);
if (!col.ok) {
  console.log(`❌ сбор провален: ${col.failure}: ${col.message}`);
  process.exit(1);
}
const cands = col.output.candidates;
writeJsonAtomic(join(countryDir, 'candidates.json'), { country: 'UZ', window: { from, to }, candidates: cands });
const ch = (x) => cands.filter((c) => c.channel === x).length;
const collectReqs = reqs.length;
console.log(`Кандидатов: ${cands.length} — канал А ${ch('A')}, Б ${ch('B')}, В ${ch('C')}; запросов ${collectReqs}, ${sec().trim()} с`);
for (const f of col.output.sourceFailures) console.log(`  ${f.critical ? 'КРИТИЧНО' : 'предупреждение'} ${f.sourceId}: ${f.message}`);
report.steps.collect = {
  candidates: cands.length,
  channels: { A: ch('A'), B: ch('B'), C: ch('C') },
  requests: collectReqs,
  sourceFailures: col.output.sourceFailures,
};

// lex.uz — единственная правовая база UZ: без неё отбор «по всем кандидатам» бессмыслен, модель не тратим.
const lexFail = col.output.sourceFailures.find((f) => uz.sources.find((s) => s.id === f.sourceId && /(^|\.)lex\.uz$/.test(new URL(s.url).hostname)));
if (lexFail) {
  console.log(`\n❌ lex.uz не прочитан при сборе (${lexFail.message}) — канал Б пуст, T-1 не проводится; повторите запуск. Модель не вызывалась.`);
  process.exit(2);
}

const found = WANT.map((w) => ({ ...w, cand: cands.find((c) => c.key === `reg:${w.reg}`) ?? null }));
for (const f of found) {
  mark(!!f.cand, `${f.label}: ${f.cand ? `найден среди кандидатов (${f.cand.id}, канал ${f.cand.channel})` : 'НЕ найден среди кандидатов'}`);
}

// ═════════ (б) отбор ═════════
phase = 'triage';
const batches = Math.ceil(cands.length / TRIAGE_BATCH);
console.log(`\n(б) Отбор: ${cands.length} кандидатов, ${batches} пакетов по ${TRIAGE_BATCH}, ${models.triage}…`);
const tri = await ex.triage(ctx, cands);
const triProcs = procs.filter((p) => p.phase === 'triage');
const triCost = triProcs.reduce((s, p) => s + p.costUsd, 0);
let items = [];
if (tri.ok) {
  items = tri.output.items;
  writeJsonAtomic(join(countryDir, 'triage.json'), tri.output);
} else {
  console.log(`❌ отбор провален: ${tri.failure}: ${tri.message}`);
  // Что успело: готовые пакеты out-<n>.json.
  for (let n = 1; n <= batches; n++) {
    try {
      items.push(...JSON.parse(readFileSync(join(countryDir, 'triage', `out-${n}.json`), 'utf8')).items);
    } catch {
      /* пакет не готов */
    }
  }
}
const ids = cands.map((c) => c.id);
const comp = checkCompleteness(ids, items);
const acc = accountingTotals(ids, items);
console.log(
  `Полнота (HAL-04, по всему набору): ${comp.ok ? '✅' : '❌'} кандидатов ${acc.candidates} = отобрано ${acc.selected} + отброшено с причиной ${acc.discarded}` +
    `${comp.ok ? '' : ` — ${completenessFailure(comp)}`}`,
);
mark(tri.ok, `отбор: ${tri.ok ? `${triProcs.length} процессов, все пакеты получены` : `провал ${tri.failure}: ${tri.message}`}`);
mark(comp.ok, `полнота отбора по всему набору (${acc.candidates} = ${acc.selected} + ${acc.discarded})${comp.ok ? '' : `: ${completenessFailure(comp)}`}`);

// Сырые ответы модели (до правила «канал А всегда relevant»): triage/out-<n>.json.
const raw = new Map();
for (let n = 1; n <= batches; n++) {
  try {
    for (const it of JSON.parse(readFileSync(join(countryDir, 'triage', `out-${n}.json`), 'utf8')).items) raw.set(it.id, it);
  } catch {
    /* нет пакета */
  }
}

// ═════════ (в) эталонные акты ═════════
console.log('\n(в) Эталонные акты:');
const byId = new Map(items.map((i) => [i.id, i]));
const selected = (d) => d === 'relevant' || d === 'borderline';
for (const f of found) {
  if (!f.cand) {
    console.log(`  ❌ ${f.label}: нет среди кандидатов`);
    f.selected = false;
    continue;
  }
  const it = byId.get(f.cand.id);
  const r = raw.get(f.cand.id);
  f.decision = it?.decision ?? null;
  f.modelDecision = r?.decision ?? null;
  f.selected = selected(it?.decision);
  const forced = r && it && r.decision !== it.decision ? ` (модель: ${r.decision}, код поправил — канал А)` : '';
  console.log(`  ${f.selected ? '✅' : '❌'} ${f.label}: ${f.cand.id}, канал ${f.cand.channel}, решение ${it?.decision ?? 'нет в ответе'}${forced}`);
  if (it) console.log(`     «${it.reason_text}» (уверенность ${it.confidence})`);
  mark(f.selected, `${f.label}: отобран (${it?.decision ?? 'нет в ответе'}${forced})`);
  if (r) mark(selected(r.decision) ? true : 'warn', `${f.label}: модель сама (без правила канала А) решила ${r.decision}`);
}

// ═════════ (г) статистика и оценка ═════════
console.log('\n(г) Статистика отбора:');
const count = (d) => items.filter((i) => i.decision === d).length;
const stats = { relevant: count('relevant'), borderline: count('borderline'), irrelevant: count('irrelevant') };
console.log(`  relevant ${stats.relevant}, borderline ${stats.borderline}, irrelevant ${stats.irrelevant} (всего ответов ${items.length})`);
const reasons = {};
for (const i of items.filter((x) => x.decision === 'irrelevant')) reasons[i.reason_code ?? 'без кода'] = (reasons[i.reason_code ?? 'без кода'] ?? 0) + 1;
console.log(`  причины irrelevant: ${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`);
const forcedA = execLog.filter((e) => e.event === 'triage_channel_a_forced').length;
console.log(`  канал А: ${ch('A')} (принудительно relevant кодом: ${forcedA})`);
const sel = items.filter((i) => selected(i.decision));
const candById = new Map(cands.map((c) => [c.id, c]));
const numOf = (c) => (c.key.startsWith('reg:') ? `рег. ${c.key.slice(4)}` : c.key.startsWith('num:') ? `№ ${c.key.slice(4).split('|')[0] || '—'}` : c.key);
console.log(`  Первые ${Math.min(40, sel.length)} из ${sel.length} отобранных (номер · орган · решение · название):`);
for (const [k, i] of sel.slice(0, 40).entries()) {
  const c = candById.get(i.id);
  console.log(`   ${String(k + 1).padStart(2)}. ${numOf(c)} · ${short(c.issuer || c.doc_type || '—', 40)} · ${i.decision} · ${short(c.title_original, 110)}`);
}
// Отобранные по органам — видно, «размазывает» ли тема выборку.
const byIssuer = {};
for (const i of sel) {
  const c = candById.get(i.id);
  const k = short(c.issuer || c.doc_type || '—', 50);
  byIssuer[k] = (byIssuer[k] ?? 0) + 1;
}
console.log(`  Отобранные по органам: ${Object.entries(byIssuer).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${v}`).join('; ')}`);

const triWin = triProcs.map((p) => p.fiveHour).filter((x) => typeof x === 'number');
const nSel = sel.length;
const est = {
  analyzeLo: nSel * PRICE.analyzeLo,
  analyzeHi: nSel * PRICE.analyzeHi,
  verify: PRICE.verify,
};
est.totalLo = triCost + est.analyzeLo + est.verify;
est.totalHi = triCost + est.analyzeHi + est.verify;
console.log('\n  Оценка полного прогона UZ за окно (анализ всех отобранных + одна проверка на страну):');
console.log(`   отбор (факт): ${triProcs.length} процессов, ${usd(triCost)}; окно 5 ч ${triWin.length ? `${pct(triWin[0])} → ${pct(triWin.at(-1))}` : 'нет данных'}`);
console.log(`   анализ: ${nSel} × $${PRICE.analyzeLo}–${PRICE.analyzeHi} = ${usd(est.analyzeLo)}–${usd(est.analyzeHi)}; проверка ≈ ${usd(est.verify)} (на ${nSel} карточек — больше, рост с числом карточек)`);
console.log(`   итого ≈ ${usd(est.totalLo)}–${usd(est.totalHi)} (доля 5-часового окна — в итоге, по фактическому приросту окна в этом прогоне)`);
report.steps.triage = {
  ok: tri.ok,
  processes: triProcs.length,
  costUsd: triCost,
  completeness: comp,
  accounting: acc,
  stats,
  reasons,
  forcedA,
  byIssuer,
  selected: sel.map((i) => {
    const c = candById.get(i.id);
    return { id: i.id, number: numOf(c), issuer: c.issuer, decision: i.decision, title: c.title_original, reason: i.reason_text };
  }),
};
report.estimate = { selected: nSel, ...est };

/**
 * Прирост 5-часового окна на $1 по модели — из этого прогона: разница доли окна между соседними процессами,
 * отнесённая к стоимости процесса (первый процесс не считается: доля до него неизвестна). null — нет данных.
 */
function windowPerUsd(model) {
  let dw = 0;
  let cost = 0;
  let prev;
  for (const p of procs) {
    if (typeof p.fiveHour !== 'number') continue;
    if (prev !== undefined && p.model === model) {
      dw += p.fiveHour - prev;
      cost += p.costUsd;
    }
    prev = p.fiveHour;
  }
  return cost > 0 && dw > 0 ? (dw * 100) / cost : null;
}

// ═════════ (д) анализ и проверка двух эталонных актов ═════════
let stepD = 'skipped';
const cards = [];
console.log(`\n(д) Анализ и проверка двух эталонных актов: окно 5 ч сейчас ${pct(lastWindow)} (порог ${pct(MAX_WINDOW)})`);
if (limitHit) {
  console.log(`  ⏸ пропущено: лимит подписки исчерпан (сброс ${limitHit})`);
  stepD = 'limit';
} else if (typeof lastWindow === 'number' && lastWindow > MAX_WINDOW) {
  console.log(`  ⏸ пропущено: 5-часовое окно ${pct(lastWindow)} > ${pct(MAX_WINDOW)}`);
  stepD = 'window';
} else if (!found.every((f) => f.cand)) {
  console.log('  ⏸ пропущено: не все эталонные акты найдены');
  stepD = 'not_found';
} else {
  stepD = 'done';
  const golden = loadGoldenCases(join(ROOT, 'docs', 'golden')).find((c) => c.id === 'UZ-3254-2');
  for (const f of found) {
    phase = 'analyze';
    const adir = actDir(ws, runId, 'UZ', f.cand.id);
    mkdirSync(adir, { recursive: true });
    const before = reqs.length;
    say(`${f.reg}: анализ (${models.analyze})…`);
    const a = await ex.analyze({ ...ctx, actDir: adir }, f.cand);
    const snapReqs = reqs.length - before;
    if (!a.ok) {
      console.log(`  ❌ ${f.reg}: анализ не вернул карточку — ${a.failure}: ${a.message}`);
      mark(false, `${f.label}: карточка (анализ ${a.failure})`);
      continue;
    }
    writeJsonAtomic(join(adir, 'card.json'), a.output);
    const ev = await ex.checkEvidence({ ...ctx, actDir: adir }, f.cand, a.output);
    const bad = ev.results.filter((r) => !r.ok);
    console.log(`  ${ev.ok ? '✅' : '❌'} ${f.reg}: проверка цитат (HAL-02/03) — полей ${ev.results.length}${bad.length ? `, не подтверждено: ${bad.map((r) => `${r.field}: ${r.reason}`).join('; ')}` : ', все подтверждены'}; запросов снимка ${snapReqs}`);
    mark(ev.ok, `${f.label}: карточка проходит проверку цитат${ev.ok ? '' : ` (не подтверждено: ${ev.failedFields.join(', ')})`}`);
    const entry = { reg: f.reg, id: f.cand.id, cardPath: join(adir, 'card.json'), evidence: { ok: ev.ok, failed: ev.failedFields }, snapshotRequests: snapReqs };
    if (f.reg === '3254-2' && golden) {
      const cmp = compareCard(a.output, golden.expected);
      const passed = cmp.checks.filter((x) => x.ok).length;
      console.log(`  Сравнение 3254-2 с эталоном: ${passed} из ${cmp.checks.length}`);
      const failedChecks = cmp.checks.filter((x) => !x.ok);
      if (failedChecks.length) console.log(formatChecks(failedChecks));
      mark(cmp.ok, `карточка 3254-2 против эталона: ${passed} из ${cmp.checks.length}`);
      entry.golden = { passed, total: cmp.checks.length, failed: cmp.failed };
    }
    cards.push({ f, card: a.output, ev, entry });
  }
  if (cards.length) {
    phase = 'verify';
    say(`проверка (${models.verify}) — один вызов на ${cards.length} карточки, отброшенные не передаются (бережём лимит)…`);
    const v = await ex.verify(
      ctx,
      cards.map((c) => ({ candidate: c.f.cand, card: c.card, evidenceFailedFields: c.ev.failedFields, round: 1 })),
      [],
    );
    if (!v.ok) {
      console.log(`  ❌ проверка: ${v.failure}: ${v.message}`);
      mark(false, `проверка (verify): ${v.failure}`);
    } else {
      writeJsonAtomic(join(countryDir, 'verification.json'), v.output);
      for (const c of cards) {
        const vc = v.output.cards.find((x) => x.candidate_id === c.f.cand.id);
        const notOk = (vc?.fields ?? []).filter((x) => x.status !== 'ok');
        console.log(`  ${vc?.verdict === 'confirmed' ? '✅' : '⚠'} ${c.f.reg}: verify ${vc?.verdict ?? 'нет ответа'}${notOk.length ? `; поля: ${notOk.map((x) => `${x.field} ${x.status}${x.correct_value ? ` → ${x.correct_value}` : ''} (${short(x.comment, 140)})`).join('; ')}` : ''}`);
        c.entry.verify = { verdict: vc?.verdict ?? null, fields: notOk };
        mark(vc?.verdict === 'confirmed' || vc?.verdict === 'needs_correction', `${c.f.label}: verify ${vc?.verdict ?? 'нет ответа'}`);
      }
      if (v.output.returned?.length) console.log(`  verify вернул отброшенных: ${v.output.returned.map((r) => r.id).join(', ')}`);
    }
  }
  report.steps.analyze = cards.map((c) => c.entry);
}
report.steps.stepD = stepD;

// ═════════ (е) итог ═════════
// Запросы модели через WebFetch (по транскриптам) — разрешены на analyze/verify по доменам источников.
const modelFetches = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith('.jsonl') && n.startsWith('transcript')) {
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        if (!line.includes('"WebFetch"')) continue;
        try {
          const ev = JSON.parse(line);
          for (const b of ev.message?.content ?? []) if (b.type === 'tool_use' && b.name === 'WebFetch') modelFetches.push(b.input?.url ?? '?');
        } catch {
          /* не JSON */
        }
      }
    }
  }
};
walk(countryDir);

const byPhase = {};
for (const r of reqs) byPhase[r.phase] = (byPhase[r.phase] ?? 0) + 1;
const declared = new Set(['collect', 'analyze']);
const undeclared = reqs.filter((r) => !declared.has(r.phase));
const hosts = {};
for (const r of reqs) hosts[r.host] = (hosts[r.host] ?? 0) + 1;
mark(undeclared.length === 0, `незаявленных запросов кода к сайтам: ${undeclared.length} (сбор ${byPhase.collect ?? 0}, снимки ensureSnapshot ${byPhase.analyze ?? 0}, отбор ${byPhase.triage ?? 0}, проверка ${byPhase.verify ?? 0})`);

const tot = procs.reduce(
  (s, p) => ({ cost: s.cost + p.costUsd, in: s.in + p.inputTokens, out: s.out + p.outputTokens, cr: s.cr + p.cacheRead, cw: s.cw + p.cacheWrite }),
  { cost: 0, in: 0, out: 0, cr: 0, cw: 0 },
);
const firstWin = procs.find((p) => typeof p.fiveHour === 'number')?.fiveHour;
console.log('\n═════ Итог T-1 (живой) ═════');
for (const v of verdicts) console.log(`${v.ok === 'warn' ? '⚠' : v.ok ? '✅' : '❌'} ${v.text}`);
if (stepD !== 'done') console.log(`⏸ шаг (д) не выполнен: ${{ window: `окно 5 ч ${pct(lastWindow)} > ${pct(MAX_WINDOW)}`, limit: 'лимит подписки', not_found: 'не все акты найдены' }[stepD]}`);
console.log(
  `Расход: процессов ${procs.length} (отбор ${triProcs.length}, анализ ${procs.filter((p) => p.phase === 'analyze').length}, проверка ${procs.filter((p) => p.phase === 'verify').length}); ` +
    `токены: вход ${tot.in}, выход ${tot.out}, кэш чтение ${tot.cr}, кэш запись ${tot.cw}; ${usd(tot.cost)}; окно 5 ч ${pct(firstWin)} → ${pct(lastWindow)}`,
);
console.log(`Сеть (код): ${reqs.length} запросов (${Object.entries(hosts).map(([h, n]) => `${h} ${n}`).join(', ')}); модель WebFetch: ${modelFetches.length}${modelFetches.length ? ` (${[...new Set(modelFetches)].join(', ')})` : ''}`);
// Доля окна: opus (анализ/проверка) по факту этого прогона; нет данных — по прошлым прогонам (≈ 1% на $0.6, грубо).
const opusW = windowPerUsd(models.analyze);
const wPerUsd = opusW ?? 1 / 0.6;
const triW = triWin.length > 1 ? (triWin.at(-1) - triWin[0]) * 100 : 0;
// Проверка растёт с числом карточек: цена одной карточки — из шага (д), если он был.
const verProc = procs.filter((p) => p.phase === 'verify');
const verPerCard = verProc.length && cards.length ? verProc.reduce((s, p) => s + p.costUsd, 0) / cards.length : null;
const winLo = triW + (est.analyzeLo + est.verify) * wPerUsd;
const winHi = triW + (est.analyzeHi + est.verify) * wPerUsd;
console.log(
  `Оценка полного прогона UZ: ${nSel} отобранных → ≈ ${usd(est.totalLo)}–${usd(est.totalHi)} (отбор факт + ${nSel} × анализ + проверка $${PRICE.verify}); ` +
    `≈ ${winLo.toFixed(0)}–${winHi.toFixed(0)}% 5-часового окна (${opusW ? `opus по факту: ${opusW.toFixed(1)}% окна на $1` : 'грубо: 1% на $0.6'}), т.е. ≈ ${(winHi / 100).toFixed(1)} окна`,
);
if (verPerCard) {
  const vAll = verPerCard * nSel;
  console.log(
    `  с проверкой, растущей с числом карточек (≈ ${usd(verPerCard)} за карточку по шагу (д)): ≈ ${usd(est.totalLo - est.verify + vAll)}–${usd(est.totalHi - est.verify + vAll)}, ` +
      `≈ ${(winLo + (vAll - est.verify) * wPerUsd).toFixed(0)}–${(winHi + (vAll - est.verify) * wPerUsd).toFixed(0)}% окна`,
  );
}
report.estimate = { ...report.estimate, windowPctPerUsdOpus: opusW, triageWindowPct: triW, windowLo: winLo, windowHi: winHi, verifyPerCard: verPerCard };
console.log(`Время ${sec().trim()} с. Рабочая папка: ${ws}`);

report.spend = { processes: procs, total: tot, windowFirst: firstWin ?? null, windowLast: lastWindow ?? null };
report.network = { byPhase, hosts, undeclared, modelFetches };
report.verdicts = verdicts;
writeFileSync(join(ws, 't1-report.json'), JSON.stringify(report, null, 2));
console.log(`Отчёт: ${join(ws, 't1-report.json')}`);

const allSelected = found.every((f) => f.cand && f.selected);
if (limitHit && !tri.ok) process.exit(2);
process.exit(allSelected ? 0 : 1);
