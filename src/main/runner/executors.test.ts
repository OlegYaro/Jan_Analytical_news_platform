// Боевые исполнители этапов на подменённом runStage и fixtures: без сети и без claude.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { Candidate } from '../../shared/pipeline-types.ts';
import type { Card, ScreenOutput, TriageOutput, Verification } from '../../shared/schema-types.ts';
import type { Country, Source, WatchedAct } from '../../shared/types.ts';
import type { FetchResult, Fetcher } from '../collect/fetcher-types.ts';
import { watchedStateFile } from '../collect/collector.ts';
import { TRANSLATE_BATCH, TRIAGE_BATCH, VERIFY_CARD_BATCH, VERIFY_REJECTED_BATCH, allowedDomains, createStageExecutors, createTranslator, NO_CLAUDE_MESSAGE } from './executors.ts';
import type { ExecutorOptions } from './executors.ts';
import type { RunStageOptions, StageResult } from './claude-runner.ts';
import { Orchestrator, PauseSignal } from './orchestrator.ts';
import type { StageContext, VerifyCardInput } from './orchestrator.ts';
import { cand, makeCard, settingsFor } from './fixtures/orchestrator-stubs.ts';

const SCHEMAS = resolve(import.meta.dirname, '..', '..', '..', 'schemas');
const FIX = resolve(import.meta.dirname, '..', 'collect', 'fixtures');
const fx = (name: string): string => readFileSync(join(FIX, name), 'utf8');

// ───────── Окружение ─────────

function src(id: string, type: Source['type'], url: string, extra: Partial<Source> = {}): Source {
  return {
    id,
    name: new URL(url).hostname,
    url,
    type,
    language: 'uz',
    priority: 'main',
    enabled: true,
    state: 'unchecked',
    stateReason: '',
    checkedAt: null,
    seenLatest: [],
    note: '',
    ...extra,
  };
}

function watchedAct(url: string, reg: string, extra: Partial<WatchedAct> = {}): WatchedAct {
  return { id: `act-${reg}`, title: `Положение ${reg}`, registrationNumber: reg, url, state: 'unchecked', stateReason: '', ...extra };
}

function uz(extra: Partial<Country> = {}): Country {
  return {
    code: 'UZ',
    name: 'Узбекистан',
    languages: ['uz', 'ru'],
    active: true,
    // Проверенные источники (PRM-04: WebFetch только по ✅/⚠).
    sources: [src('s1', 'legal_base', 'https://lex.uz', { state: 'ok' }), src('s2', 'regulator', 'https://cbu.uz', { state: 'warn' }), src('s3', 'news', 'https://www.gazeta.uz')],
    watchedActs: [watchedAct('https://www.lex.uz/docs/-4888804', '3254')],
    lastCheckedAt: null,
    lastRunSummary: '',
    ...extra,
  };
}

function makeCtx(o: { country?: Country; saveTranscripts?: boolean } = {}): StageContext {
  const ws = mkdtempSync(join(tmpdir(), 'rw-exec-'));
  const runDir = join(ws, 'runs', 'r1');
  const countryDir = join(runDir, 'UZ');
  mkdirSync(countryDir, { recursive: true });
  const s = settingsFor(ws);
  return {
    runId: 'r1',
    runDir,
    workspaceDir: ws,
    countryDir,
    country: o.country ?? uz(),
    mode: 'manual',
    window: { from: '2026-10-01', to: '2026-11-17' },
    settings: { ...s, advanced: { ...s.advanced, saveTranscripts: !!o.saveTranscripts } },
  };
}

interface Call {
  stage: string;
  prompt: string;
  input: Record<string, unknown>;
  opts: RunStageOptions;
}

/** Подмена runStage: читает input.json, как это сделала бы модель, и отвечает обработчиком. */
function fakeRunner(handler: (c: Call, n: number) => unknown | StageResult) {
  const calls: Call[] = [];
  const runStage = async (opts: RunStageOptions): Promise<StageResult> => {
    const inputPath = opts.invocation.prompt.split(' ').slice(1).join(' ');
    const c: Call = {
      stage: opts.invocation.stage,
      prompt: opts.invocation.args[1]!,
      input: JSON.parse(readFileSync(inputPath, 'utf8')) as Record<string, unknown>,
      opts,
    };
    calls.push(c);
    const out = handler(c, calls.filter((x) => x.stage === c.stage).length);
    if (out && typeof out === 'object' && 'denied' in out && 'durationMs' in out) return out as StageResult;
    return { ok: true, output: out, usage: { input_tokens: 10, output_tokens: 2 }, modelUsage: null, costUsd: 0.01, durationMs: 3, attempts: 1, exitCode: 0, denied: [] };
  };
  return { runStage, calls };
}

function fakeFetcher(route: (url: string) => FetchResult | null = () => null): Fetcher & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async get(url: string) {
      urls.push(url);
      return route(url) ?? { ok: true, status: 200, url, body: `<html><head><title>Act</title></head><body><p>Text of ${url}</p></body></html>`, contentType: 'text/html' };
    },
    async postForm(url: string) {
      urls.push(`POST ${url}`);
      return { ok: false, kind: 'http', status: 404, message: 'нет' };
    },
  };
}

function exec(o: Partial<ExecutorOptions> & { runStage: ExecutorOptions['runStage'] }) {
  return createStageExecutors({
    schemasDir: SCHEMAS,
    claudeBin: () => '/usr/local/bin/claude',
    claudeEnv: () => ({ PATH: '/usr/bin' }),
    fetcher: fakeFetcher(),
    collector: { collect: async () => ({ ok: true, output: { candidates: [] } }) },
    ...o,
  });
}

const decideAll = (input: Record<string, unknown>, decision: 'relevant' | 'irrelevant' = 'relevant', drop: string[] = []): TriageOutput => ({
  country: 'UZ',
  items: (input['candidates'] as Array<{ id: string }>)
    .filter((c) => !drop.includes(c.id))
    .map((c) => ({
      id: c.id,
      decision,
      reason_code: decision === 'irrelevant' ? ('other_sector' as const) : null,
      reason_text: 'r',
      confidence: 'high' as const,
    })),
});

const many = (n: number): Candidate[] => Array.from({ length: n }, (_, i) => cand(`c${i + 1}`));

// ───────── TRIAGE ─────────

test('triage: 95 кандидатов → 3 пакета (40/40/15), ответы склеены, входы в triage/in-<n>.json', async () => {
  const ctx = makeCtx();
  const f = fakeRunner((c) => {
    const out = decideAll(c.input);
    assert.deepEqual(c.opts.validate(out), { ok: true }, 'ответ проходит схему triage');
    return out;
  });
  const ex = exec({ runStage: f.runStage });
  const r = await ex.triage(ctx, many(95));
  assert.ok(r.ok);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(
    f.calls.map((c) => (c.input['candidates'] as unknown[]).length),
    [TRIAGE_BATCH, TRIAGE_BATCH, 15],
  );
  assert.equal(r.output.items.length, 95);
  assert.equal(new Set(r.output.items.map((i) => i.id)).size, 95);
  assert.equal(r.output.country, 'UZ');
  assert.equal(r.processes?.length, 3);
  const in1 = JSON.parse(readFileSync(join(ctx.countryDir, 'triage', 'in-1.json'), 'utf8'));
  assert.equal(in1.topic, ctx.settings.topic);
  assert.equal(in1.perspective, ctx.settings.perspective);
  assert.deepEqual(in1.country, { code: 'UZ', name: 'Узбекистан' });
  assert.deepEqual(Object.keys(in1.candidates[0]).sort(), ['channel', 'date', 'doc_type', 'id', 'issuer', 'snippet', 'title_en', 'title_original', 'url'].sort());
  assert.ok(existsSync(join(ctx.countryDir, 'triage', 'in-3.json')));
  // cwd — реальный путь папки страны, промпт — /triage <абсолютный путь>
  const real = realpathSync(ctx.countryDir);
  for (const c of f.calls) {
    assert.equal(c.opts.invocation.cwd, real);
    assert.match(c.prompt, new RegExp(`^/triage ${real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/triage/in-\\d\\.json$`));
    assert.equal(c.opts.invocation.model, 'sonnet');
  }
});

test('triage: потеря id в пакете → повтор только этого пакета, один раз, с перечнем потерянных', async () => {
  const ctx = makeCtx();
  const f = fakeRunner((c, n) => {
    const ids = (c.input['candidates'] as Array<{ id: string }>).map((x) => x.id);
    // второй пакет (c41…c80) в первый раз теряет c50
    if (ids.includes('c50') && n === 2) return decideAll(c.input, 'relevant', ['c50']);
    return decideAll(c.input);
  });
  const ex = exec({ runStage: f.runStage });
  const r = await ex.triage(ctx, many(95));
  assert.ok(r.ok);
  assert.equal(f.calls.length, 4);
  const batch2 = f.calls.filter((c) => (c.input['candidates'] as Array<{ id: string }>).some((x) => x.id === 'c50'));
  assert.equal(batch2.length, 2);
  assert.doesNotMatch(batch2[0]!.prompt, /incomplete/);
  assert.match(batch2[1]!.prompt, /missing candidate ids: c50/);
  assert.equal(r.output.items.length, 95);
});

test('triage: повторная потеря в пакете → возвращается как есть (решает оркестратор), без третьего вызова', async () => {
  const ctx = makeCtx();
  const f = fakeRunner((c) => decideAll(c.input, 'relevant', ['c3']));
  const ex = exec({ runStage: f.runStage });
  const r = await ex.triage(ctx, many(5));
  assert.ok(r.ok);
  assert.equal(f.calls.length, 2);
  assert.equal(r.output.items.length, 4);
});

test('triage: повтор оркестратора (ctx.retry) перезапускает только неполный пакет', async () => {
  const ctx = makeCtx();
  let lose = true;
  const f = fakeRunner((c) => {
    const ids = (c.input['candidates'] as Array<{ id: string }>).map((x) => x.id);
    return ids.includes('c50') && lose ? decideAll(c.input, 'relevant', ['c50']) : decideAll(c.input);
  });
  const ex = exec({ runStage: f.runStage });
  const first = await ex.triage(ctx, many(95));
  assert.ok(first.ok);
  assert.equal(f.calls.length, 4); // 3 пакета + повтор второго
  lose = false;
  const details = { ok: false, missing: ['c50'], extra: [], duplicates: [], invalidIrrelevant: [] };
  const again = await ex.triage({ ...ctx, retry: { reason: 'completeness', message: 'потеряны кандидаты: c50', details } }, many(95));
  assert.ok(again.ok);
  assert.equal(f.calls.length, 5, 'полные пакеты 1 и 3 взяты из out-<n>.json');
  assert.match(f.calls[4]!.prompt, /missing candidate ids: c50/);
  assert.equal(again.output.items.length, 95);
});

test('triage: канал А, отброшенный моделью, принудительно relevant с пометкой', async () => {
  const ctx = makeCtx();
  const f = fakeRunner((c) => decideAll(c.input, 'irrelevant'));
  const ex = exec({ runStage: f.runStage });
  const r = await ex.triage(ctx, [cand('a1', 'A'), cand('b1', 'B')]);
  assert.ok(r.ok);
  const a = r.output.items.find((i) => i.id === 'a1')!;
  const b = r.output.items.find((i) => i.id === 'b1')!;
  assert.equal(a.decision, 'relevant');
  assert.equal(a.reason_code, null);
  assert.match(a.reason_text, /channel A/);
  assert.ok(a.reason_text.length <= 200);
  assert.equal(b.decision, 'irrelevant');
  const log = readFileSync(join(ctx.countryDir, 'log.jsonl'), 'utf8');
  assert.match(log, /triage_channel_a_forced/);
});

test('без claude: провал spawn с русским текстом, процессы не запускаются', async () => {
  const ctx = makeCtx();
  const f = fakeRunner(() => ({}));
  const ex = exec({ runStage: f.runStage, claudeBin: () => null });
  const r = await ex.triage(ctx, many(3));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.failure === 'spawn');
  assert.ok(!r.ok && r.message === NO_CLAUDE_MESSAGE);
  assert.match(NO_CLAUDE_MESSAGE, /Claude Code/);
  assert.equal(f.calls.length, 0);
});

test('budget.beforeProcess вызывается перед каждым процессом', async () => {
  const ctx = makeCtx();
  let n = 0;
  const f = fakeRunner((c) => decideAll(c.input));
  const ex = exec({ runStage: f.runStage, budget: { beforeProcess: async () => void n++ } });
  await ex.triage(ctx, many(81));
  assert.equal(n, 3);
});

// ───────── ANALYZE ─────────

test('analyze: снимок только для отобранного, input.json с абсолютными реальными путями, reviewer_notes', async () => {
  const ctx = makeCtx({ saveTranscripts: true });
  const fetcher = fakeFetcher();
  const f = fakeRunner((c) => makeCard((c.input['candidate'] as { id: string }).id, 'UZ'));
  const ex = exec({ runStage: f.runStage, fetcher });
  const selected = cand('lexuz-1', 'B');
  // три кандидата в стране, на анализ — один
  const notes = {
    round: 1,
    fields: [{ field: 'act.effective_date', status: 'mismatch' as const, correct_value: '2027-01-13', comment: 'wrong date' }],
    evidenceFailedFields: ['act.number'],
  };
  const r = await ex.analyze({ ...ctx, actDir: join(ctx.countryDir, 'acts', 'lexuz-1') }, selected, notes);
  assert.ok(r.ok);
  assert.equal(fetcher.urls.length, 1, 'скачана только страница отобранного акта');
  assert.deepEqual(fetcher.urls, [selected.url]);

  const real = realpathSync(ctx.countryDir);
  const adir = join(real, 'acts', 'lexuz-1');
  const input = JSON.parse(readFileSync(join(adir, 'input.json'), 'utf8'));
  assert.equal(input.topic, ctx.settings.topic);
  assert.equal(input.perspective, ctx.settings.perspective);
  assert.deepEqual(input.country, { code: 'UZ', name: 'Узбекистан', languages: ['uz', 'ru'] });
  assert.deepEqual(input.candidate, {
    id: 'lexuz-1',
    title_original: selected.title_original,
    issuer: selected.issuer,
    date: selected.date,
    url: selected.url,
    channel: 'B',
  });
  assert.equal(input.snapshot_text_path, join(adir, 'snapshot.txt'));
  assert.equal(input.snapshot_html_path, join(adir, 'snapshot.html'));
  assert.ok(isAbsolute(input.snapshot_text_path) && existsSync(input.snapshot_text_path));
  assert.ok(existsSync(input.snapshot_html_path));
  assert.deepEqual(input.related_snapshots, []);
  assert.deepEqual(input.allowed_domains, ['lex.uz', 'www.lex.uz', 'cbu.uz', 'www.cbu.uz']);
  assert.equal(input.ledger_entry, undefined);
  assert.equal(input.reviewer_notes.length, 2);
  assert.equal(input.reviewer_notes[0].field, 'act.effective_date');
  assert.equal(input.reviewer_notes[0].correct_value, '2027-01-13');
  assert.equal(input.reviewer_notes[1].field, 'act.number');

  const call = f.calls[0]!;
  assert.equal(call.stage, 'analyze');
  assert.equal(call.opts.invocation.cwd, real);
  assert.equal(call.prompt, `/analyze-act ${join(adir, 'input.json')}`);
  assert.ok(call.opts.invocation.allowedTools.includes('WebFetch(domain:lex.uz)'));
  assert.ok(!call.opts.invocation.allowedTools.some((t) => t.includes('gazeta')));
  assert.equal(call.opts.transcriptPath, join(adir, 'transcript.jsonl'));
  assert.equal(call.opts.invocation.model, 'opus');
  assert.equal(r.processes?.[0]?.act, 'lexuz-1');

  // второй вызов (круг 2) — снимок уже есть, сеть не трогаем
  await ex.analyze(ctx, selected);
  assert.equal(fetcher.urls.length, 1);
  const input2 = JSON.parse(readFileSync(join(adir, 'input.json'), 'utf8'));
  assert.equal(input2.reviewer_notes, undefined);
});

test('analyze: ledger_entry во входе, если ключ в журнале; связанные снимки из snapshot.json', async () => {
  const ctx = makeCtx();
  const entry = { key: 'reg:3254-2', first_reported_at: '2026-10-20', last_stage: 'published', effective_date: '2027-01-13', title_en: 'T', run_id: 'r0' };
  mkdirSync(join(ctx.workspaceDir, 'state', 'ledger'), { recursive: true });
  writeFileSync(join(ctx.workspaceDir, 'state', 'ledger', 'UZ.json'), JSON.stringify([entry]));
  // снимок канала А уже сделан сборщиком, со связанной страницей
  const adir = join(ctx.countryDir, 'acts', 'lexuz-8530799');
  mkdirSync(join(adir, 'related'), { recursive: true });
  writeFileSync(join(adir, 'snapshot.html'), '<p>x</p>');
  writeFileSync(join(adir, 'snapshot.txt'), 'x');
  writeFileSync(join(adir, 'related', '1.txt'), 'base');
  writeFileSync(join(adir, 'related', '1.html'), '<p>base</p>');
  writeFileSync(
    join(adir, 'snapshot.json'),
    JSON.stringify({ url: 'u', finalUrl: 'u', takenAt: '', bytes: 1, related: [{ label: 'Базовый акт', url: 'https://lex.uz/docs/4888804', ok: true, html: 'related/1.html', text: 'related/1.txt' }] }),
  );
  const fetcher = fakeFetcher();
  const f = fakeRunner(() => makeCard('lexuz-8530799', 'UZ'));
  const ex = exec({ runStage: f.runStage, fetcher });
  const r = await ex.analyze(ctx, cand('lexuz-8530799', 'A', { key: 'reg:3254-2', maybeUpdate: true }));
  assert.ok(r.ok);
  assert.equal(fetcher.urls.length, 0);
  const input = f.calls[0]!.input as Record<string, any>;
  assert.deepEqual(input['ledger_entry'], entry);
  const realAdir = realpathSync(adir);
  assert.deepEqual(input['related_snapshots'], [
    { label: 'Базовый акт', url: 'https://lex.uz/docs/4888804', text_path: join(realAdir, 'related', '1.txt'), html_path: join(realAdir, 'related', '1.html') },
  ]);
  assert.equal(f.calls[0]!.opts.transcriptPath, undefined, 'транскрипты выключены');
});

test('analyze: страница акта не скачалась → понятный провал source, модель не вызывается', async () => {
  const ctx = makeCtx();
  const fetcher = fakeFetcher(() => ({ ok: false, kind: 'network', message: 'Сайт не отвечает' }));
  const f = fakeRunner(() => ({}));
  const ex = exec({ runStage: f.runStage, fetcher });
  const r = await ex.analyze(ctx, cand('x1'));
  assert.ok(!r.ok && r.failure === 'source');
  assert.ok(!r.ok && /Сайт не отвечает/.test(r.message));
  assert.equal(f.calls.length, 0);
});

// ───────── Проверка цитат ─────────

/** Все цитаты карточки — для «снимка», в котором они есть дословно. */
function quotesOf(card: Card): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'quote' && typeof x === 'string') out.push(x);
        else walk(x);
      }
    }
  };
  walk(card);
  return out;
}

test('checkEvidence: ложная цитата → failedFields и evidence-check.json; верные цитаты → ok', async () => {
  const ctx = makeCtx();
  const good = makeCard('a1', 'UZ');
  const adir = join(ctx.countryDir, 'acts', 'a1');
  mkdirSync(adir, { recursive: true });
  writeFileSync(join(adir, 'snapshot.txt'), quotesOf(good).join('\n') + '\n');
  const ex = exec({ runStage: fakeRunner(() => ({})).runStage });

  const ok = await ex.checkEvidence!(ctx, cand('a1'), good);
  assert.equal(ok.ok, true, JSON.stringify(ok.failedFields));
  assert.deepEqual(ok.failedFields, []);

  const bad = structuredClone(good);
  bad.act.title_original.quote = 'Этой цитаты нет в снимке страницы';
  const r = await ex.checkEvidence!(ctx, cand('a1'), bad);
  assert.equal(r.ok, false);
  assert.ok(r.failedFields.some((f) => f.includes('title_original')), JSON.stringify(r.failedFields));
  const saved = JSON.parse(readFileSync(join(adir, 'evidence-check.json'), 'utf8'));
  assert.equal(saved.ok, false);
  assert.deepEqual(saved.failedFields, r.failedFields);
  assert.ok(Array.isArray(saved.results) && saved.results.length > 0);
});

test('checkEvidence: цитата из связанной страницы (related/1.txt) засчитывается', async () => {
  const ctx = makeCtx();
  const card = makeCard('a2', 'UZ');
  const adir = join(ctx.countryDir, 'acts', 'a2');
  mkdirSync(join(adir, 'related'), { recursive: true });
  const qs = quotesOf(card);
  const base = card.amends.base_act_title.quote;
  writeFileSync(join(adir, 'snapshot.txt'), qs.filter((q) => q !== base).join('\n'));
  writeFileSync(join(adir, 'related', '1.txt'), base);
  const ex = exec({ runStage: fakeRunner(() => ({})).runStage });
  const r = await ex.checkEvidence!(ctx, cand('a2'), card);
  assert.equal(r.ok, true, JSON.stringify(r.failedFields));
});

// ───────── VERIFY ─────────

function verifyInputs(ctx: StageContext, ids: string[], failed: Record<string, string[]> = {}): VerifyCardInput[] {
  return ids.map((id) => {
    const adir = join(ctx.countryDir, 'acts', id);
    mkdirSync(adir, { recursive: true });
    writeFileSync(join(adir, 'card.json'), JSON.stringify(makeCard(id, 'UZ')));
    writeFileSync(join(adir, 'snapshot.txt'), 'x');
    if (failed[id]) {
      writeFileSync(
        join(adir, 'evidence-check.json'),
        JSON.stringify({ ok: false, failedFields: failed[id], results: failed[id].map((f) => ({ field: f, ok: false, reason: 'quote not found' })) }),
      );
    }
    return { candidate: cand(id), card: makeCard(id, 'UZ'), evidenceFailedFields: failed[id] ?? [], round: 1 };
  });
}

const confirm = (input: Record<string, unknown>, skip: string[] = []): Verification => ({
  country: 'UZ',
  cards: (input['cards'] as Array<{ candidate_id: string }>)
    .filter((c) => !skip.includes(c.candidate_id))
    .map((c) => ({ candidate_id: c.candidate_id, fields: [], verdict: 'confirmed' as const })),
  returned: [],
  watched_acts_check: [],
});

test('verify: вход содержит карточки с путями, отброшенных, watched_acts и evidence_check', async () => {
  const ctx = makeCtx();
  mkdirSync(join(ctx.workspaceDir, 'state'), { recursive: true });
  writeFileSync(
    watchedStateFile(ctx.workspaceDir),
    JSON.stringify({ 'https://www.lex.uz/docs/-4888804': { url: 'https://www.lex.uz/docs/-4888804', lastSeenEdition: '2027-01-13', knownEditions: ['2026-07-20', '2027-01-13'] } }),
  );
  const cards = verifyInputs(ctx, ['a1', 'a2'], { a2: ['act.number'] });
  const rejected = [{ candidate: cand('r1', 'B', { title_original: 'Об утверждении штатов' }), reason_code: 'personnel_appointment' as const, reason_text: 'staff' }];
  const f = fakeRunner((c) => {
    const out = confirm(c.input);
    assert.deepEqual(c.opts.validate(out), { ok: true });
    return out;
  });
  const ex = exec({ runStage: f.runStage });
  const r = await ex.verify(ctx, cards, rejected);
  assert.ok(r.ok);
  const input = f.calls[0]!.input as Record<string, any>;
  const real = realpathSync(ctx.countryDir);
  assert.deepEqual(input['country'], { code: 'UZ', name: 'Узбекистан', languages: ['uz', 'ru'] });
  assert.equal(input['topic'], ctx.settings.topic);
  assert.deepEqual(input['allowed_domains'], ['lex.uz', 'www.lex.uz', 'cbu.uz', 'www.cbu.uz']);
  assert.equal(input['cards'][0].card_path, join(real, 'acts', 'a1', 'card.json'));
  assert.equal(input['cards'][0].snapshot_text_path, join(real, 'acts', 'a1', 'snapshot.txt'));
  assert.deepEqual(input['rejected'], []);
  assert.deepEqual((f.calls[1]!.input as Record<string, any>)['rejected'], [{ id: 'r1', title: 'Об утверждении штатов', issuer: 'Central Bank', date: '2026-11-10', url: 'https://lex.uz/docs/r1', reason: 'personnel_appointment: staff' }]);
  assert.deepEqual(input['watched_acts'], [{ title: 'Положение 3254', registration_number: '3254', url: 'https://www.lex.uz/docs/-4888804', latest_edition_date: '2027-01-13' }]);
  assert.deepEqual(input['evidence_check'], [{ candidate_id: 'a2', failed_fields: ['act.number'], details: [{ field: 'act.number', ok: false, reason: 'quote not found' }] }]);
  assert.equal(f.calls[0]!.opts.invocation.cwd, real);
  assert.equal(f.calls[0]!.prompt, `/verify-report ${join(real, 'verify', 'in-1.json')}`);
  assert.equal(f.calls[1]!.prompt, `/verify-report ${join(real, 'verify', 'in-2.json')}`);
  // следующий проход — новый файл входа
  await ex.verify(ctx, cards, []);
  assert.equal(f.calls[2]!.prompt, `/verify-report ${join(real, 'verify', 'in-3.json')}`);
});

test('verify: карточка пропущена в ответе → один повтор; снова пропущена → провал schema по-русски', async () => {
  const ctx = makeCtx();
  const cards = verifyInputs(ctx, ['a1', 'a2']);
  const f = fakeRunner((c) => confirm(c.input, ['a2']));
  const ex = exec({ runStage: f.runStage });
  const r = await ex.verify(ctx, cards, []);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1]!.prompt, /candidate_id values: a2/);
  assert.ok(!r.ok && r.failure === 'schema');
  assert.ok(!r.ok && /a2/.test(r.message) && /Проверка отчёта/.test(r.message));
  assert.equal(r.processes?.length, 2);

  const g = fakeRunner((c, n) => confirm(c.input, n === 1 ? ['a2'] : []));
  const r2 = await exec({ runStage: g.runStage }).verify(ctx, cards, []);
  assert.ok(r2.ok);
  assert.equal(r2.output.cards.length, 2);
});

test('verify: лимит в процессе → Outcome limit с временем сброса', async () => {
  const ctx = makeCtx();
  const cards = verifyInputs(ctx, ['a1']);
  const f = fakeRunner(
    (): StageResult => ({ ok: false, failure: 'limit', message: 'Исчерпан лимит подписки Claude', resetsAt: '2026-11-18T12:00:00.000Z', attempts: 1, durationMs: 1, exitCode: 1, denied: [] }),
  );
  const r = await exec({ runStage: f.runStage }).verify(ctx, cards, []);
  assert.ok(!r.ok && r.failure === 'limit' && r.resetsAt === '2026-11-18T12:00:00.000Z');
});

const rejectedList = (k: number) =>
  Array.from({ length: k }, (_, i) => ({ candidate: cand(`r${i}`, 'B'), reason_code: 'other_sector' as const, reason_text: 'x' }));

test('verify: 7 карточек → пакеты 3+3+1, у каждого свои evidence_check; watched_acts только в первом; склейка', async () => {
  assert.equal(VERIFY_CARD_BATCH, 3);
  const ctx = makeCtx();
  const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
  const cards = verifyInputs(ctx, ids, { a2: ['act.number'], a5: ['act.title'] });
  const f = fakeRunner((c) => {
    const out = confirm(c.input);
    out.watched_acts_check = (c.input['watched_acts'] as unknown[]).length ? [{ registration_number: '3254', new_edition_found: false }] : [];
    return out;
  });
  const r = await exec({ runStage: f.runStage }).verify(ctx, cards, []);
  assert.ok(r.ok);
  assert.equal(f.calls.length, 3);
  const ins = f.calls.map((c) => c.input as Record<string, any>);
  assert.deepEqual(ins.map((i) => i['cards'].map((x: { candidate_id: string }) => x.candidate_id)), [['a1', 'a2', 'a3'], ['a4', 'a5', 'a6'], ['a7']]);
  assert.deepEqual(ins.map((i) => i['evidence_check'].map((e: { candidate_id: string }) => e.candidate_id)), [['a2'], ['a5'], []]);
  assert.deepEqual(ins.map((i) => i['watched_acts'].length), [1, 0, 0]);
  assert.ok(ins.every((i) => i['rejected'].length === 0));
  assert.deepEqual(r.output.cards.map((c) => c.candidate_id), ids);
  assert.equal(r.output.watched_acts_check.length, 1);
  assert.equal(r.output.country, 'UZ');
  assert.equal(r.processes?.length, 3);
});

test('verify: 200 отброшенных → 3 пакета по ≤80, без карточек; returned склеивается без дублей; watched_acts в первом', async () => {
  assert.equal(VERIFY_REJECTED_BATCH, 80);
  const ctx = makeCtx();
  const f = fakeRunner((c) => {
    const out = confirm(c.input);
    const rej = c.input['rejected'] as Array<{ id: string }>;
    out.returned = [{ id: rej[0]!.id, reason: 'x' }, { id: 'r0', reason: 'dup' }];
    return out;
  });
  const r = await exec({ runStage: f.runStage }).verify(ctx, [], rejectedList(200));
  assert.ok(r.ok);
  const ins = f.calls.map((c) => c.input as Record<string, any>);
  assert.deepEqual(ins.map((i) => i['rejected'].length), [80, 80, 40]);
  assert.ok(ins.every((i) => i['cards'].length === 0));
  assert.deepEqual(ins.map((i) => i['watched_acts'].length), [1, 0, 0]);
  assert.deepEqual(r.output.returned.map((x) => x.id), ['r0', 'r80', 'r160']);
});

test('verify: карточки и отброшенные — отдельные процессы; watched_acts в первом пакете карточек', async () => {
  const ctx = makeCtx();
  const cards = verifyInputs(ctx, ['a1', 'a2', 'a3', 'a4']);
  const f = fakeRunner((c) => confirm(c.input));
  const r = await exec({ runStage: f.runStage }).verify(ctx, cards, rejectedList(5));
  assert.ok(r.ok);
  const ins = f.calls.map((c) => c.input as Record<string, any>);
  assert.deepEqual(ins.map((i) => [i['cards'].length, i['rejected'].length, i['watched_acts'].length]), [[3, 0, 1], [1, 0, 0], [0, 5, 0]]);
});

test('verify: ни карточек, ни отброшенных — вызова нет', async () => {
  const f = fakeRunner(() => ({}));
  const r = await exec({ runStage: f.runStage }).verify(makeCtx(), [], []);
  assert.ok(r.ok && r.output.cards.length === 0);
  assert.equal(f.calls.length, 0);
});

test('verify: потерянная карточка в пакете → повтор только этого пакета, один раз', async () => {
  const ctx = makeCtx();
  const cards = verifyInputs(ctx, ['a1', 'a2', 'a3', 'a4']);
  const f = fakeRunner((c, n) => confirm(c.input, n === 2 ? ['a4'] : []));
  const r = await exec({ runStage: f.runStage }).verify(ctx, cards, []);
  assert.ok(r.ok);
  assert.equal(f.calls.length, 3);
  assert.match(f.calls[2]!.prompt, /candidate_id values: a4/);
  assert.deepEqual(r.output.cards.map((c) => c.candidate_id), ['a1', 'a2', 'a3', 'a4']);
});

test('verify: сбой второго пакета → failure; при повторе первый пакет не запускается', async () => {
  const ctx = makeCtx();
  const cards = verifyInputs(ctx, ['a1', 'a2', 'a3', 'a4']);
  const bad = (): StageResult => ({ ok: false, failure: 'timeout', message: 'Время вышло', attempts: 1, durationMs: 1, exitCode: 1, denied: [] });
  const f = fakeRunner((c, n) => (n === 2 ? bad() : confirm(c.input)));
  const ex = exec({ runStage: f.runStage });
  const r = await ex.verify(ctx, cards, []);
  assert.ok(!r.ok && r.failure === 'timeout');
  assert.equal(f.calls.length, 2);
  const g = fakeRunner((c) => confirm(c.input));
  const r2 = await exec({ runStage: g.runStage }).verify(ctx, cards, []);
  assert.ok(r2.ok);
  assert.equal(g.calls.length, 1);
  assert.deepEqual((g.calls[0]!.input as Record<string, any>)['cards'].map((x: { candidate_id: string }) => x.candidate_id), ['a4']);
  assert.deepEqual(r2.output.cards.map((c) => c.candidate_id), ['a1', 'a2', 'a3', 'a4']);
});

// ───────── Домены ─────────

test('allowedDomains (PRM-04): только ✅ и ⚠; «не проверен», ❌ и выключенные — нет; новости — нет; акты — по состоянию', () => {
  const c = uz({
    sources: [
      src('a', 'legal_base', 'https://lex.uz', { state: 'ok' }),
      src('b', 'regulator', 'https://cbu.uz/ru/', { state: 'fail' }),
      src('c', 'drafts', 'https://regulation.gov.uz', { state: 'warn' }),
      src('d', 'regulator', 'https://old.example.uz', { enabled: false, state: 'ok' }),
      src('e', 'news', 'https://www.gazeta.uz', { state: 'ok' }),
      src('f', 'regulator', 'https://unchecked.example.uz', { state: 'unchecked' }),
    ],
    watchedActs: [
      watchedAct('https://www.lex.uz/docs/-4888804', '3254', { state: 'ok' }),
      watchedAct('https://bad.example.org/x', '1', { state: 'fail' }),
      watchedAct('https://new.example.org/y', '2', { state: 'unchecked' }),
      watchedAct('https://warn.example.org/z', '3', { state: 'warn' }),
    ],
  });
  const d = allowedDomains(c);
  assert.deepEqual(d, ['lex.uz', 'www.lex.uz', 'regulation.gov.uz', 'www.regulation.gov.uz', 'warn.example.org', 'www.warn.example.org']);
  for (const x of ['cbu.uz', 'unchecked.example.uz', 'old.example.uz', 'gazeta.uz', 'bad.example.org', 'new.example.org']) assert.ok(!d.some((y) => y.endsWith(x)), x);
});

test('allowedDomains: все источники «не проверены» → WebFetch не выдаётся вовсе (пустой список)', () => {
  assert.deepEqual(allowedDomains(uz({ sources: [src('a', 'legal_base', 'https://lex.uz'), src('b', 'regulator', 'https://cbu.uz')] })), []);
});

// ───────── Наводки ─────────

test('resolveLead: наводка из новостей находится на lex.uz по номеру принятия (actnum) → кандидат канала Г', async () => {
  const ctx = makeCtx();
  const fetcher = fakeFetcher((url) => {
    if (!url.includes('/search/nat')) return null;
    const lang = url.includes('/ru/') ? 'ru' : 'uz';
    if (url.includes('regnummj=1')) return { ok: true, status: 200, url, body: fx(`lexuz-search-${lang}-actnum-24-2.html`), contentType: 'text/html' };
    return { ok: true, status: 200, url, body: fx('lexuz-search-empty.html'), contentType: 'text/html' };
  });
  const ex = exec({ runStage: fakeRunner(() => ({})).runStage, fetcher });
  const lead = {
    headline: 'ЦБ изменил положение о корпоративном управлении',
    outlet: 'gazeta.uz',
    date: '2026-10-15',
    url: 'https://www.gazeta.uz/x',
    act_number: '24/2',
    act_date: '2026-09-17',
    issuer: 'Central Bank',
    summary: '',
  };
  const c = await ex.resolveLead!(ctx, { kind: 'news', lead }, []);
  assert.ok(c, 'акт найден');
  assert.equal(c.id, 'lexuz-8530799');
  assert.equal(c.key, 'reg:3254-2');
  assert.equal(c.channel, 'D');
  assert.match(c.snippet, /Наводка из новостей/);
  assert.ok(fetcher.urls.every((u) => !u.includes('/search/nat') || u.includes('actnum=24%2F2')), fetcher.urls.join('\n'));

  // уже известный кандидат с тем же номером — возвращается он, без сети
  const before = fetcher.urls.length;
  const known = cand('lexuz-8530799', 'B', { key: 'reg:3254-2' });
  const k = await ex.resolveLead!(ctx, { kind: 'news', lead: { ...lead, act_number: '3254-2' } }, [known]);
  assert.equal(k, known);
  assert.equal(fetcher.urls.length, before);

  // без номера — не подтверждается
  assert.equal(await ex.resolveLead!(ctx, { kind: 'news', lead: { ...lead, act_number: '' } }, []), null);
  // не нашлось — null
  const empty = fakeFetcher((url) => ({ ok: true, status: 200, url, body: fx('lexuz-search-empty.html'), contentType: 'text/html' }));
  const ex2 = exec({ runStage: fakeRunner(() => ({})).runStage, fetcher: empty });
  assert.equal(await ex2.resolveLead!(ctx, { kind: 'news', lead: { ...lead, act_number: '99/9' } }, []), null);
});

test('resolveLead: новая редакция отслеживаемого акта подтверждается историей редакций lex.uz', async () => {
  const ctx = makeCtx();
  const W = 'https://www.lex.uz/docs/-4888804';
  const fetcher = fakeFetcher((url) => {
    if (url === W) return { ok: true, status: 200, url, body: fx('lexuz-edition-m4888804.html'), contentType: 'text/html' };
    if (url === `${W}?ONDATE=13.01.2027`) return { ok: true, status: 200, url, body: fx('lexuz-edition-m4888804-ondate-20270113.html'), contentType: 'text/html' };
    return null;
  });
  const ex = exec({ runStage: fakeRunner(() => ({})).runStage, fetcher, now: () => new Date(2026, 10, 17, 9, 0) });
  const c = await ex.resolveLead!(ctx, { kind: 'watched_edition', check: { registration_number: '3254', new_edition_found: true, edition_date: '2027-01-13' } }, []);
  assert.ok(c);
  assert.equal(c.id, 'lexuz-8530799');
  assert.equal(c.channel, 'A');
  assert.match(c.snippet, /найдено проверкой/);
  // акт не из списка отслеживаемых — null
  assert.equal(await ex.resolveLead!(ctx, { kind: 'watched_edition', check: { registration_number: '9999', new_edition_found: true } }, []), null);
});

// ───────── NEWS и COLLECT ─────────

test('news: вход для /news-sweep (страна, тема, окно, известные номера); выключено — без процесса', async () => {
  const ctx = makeCtx();
  const f = fakeRunner(() => ({ country: 'UZ', leads: [] }));
  const ex = exec({ runStage: f.runStage });
  const off = await ex.news!(ctx, []);
  assert.ok(off.ok);
  assert.equal(f.calls.length, 0);
  const on = await ex.news!({ ...ctx, settings: { ...ctx.settings, newsEnabled: true } }, [cand('x', 'B', { key: 'reg:3254-2' }), cand('y', 'B', { key: 'num:24/2|2026-09-17|u' })]);
  assert.ok(on.ok);
  const input = f.calls[0]!.input as Record<string, any>;
  assert.equal(input['date_from'], '2026-10-01');
  assert.equal(input['date_to'], '2026-11-17');
  assert.deepEqual(input['known_ids'], ['3254-2', '24/2']);
  assert.equal(input['country'].code, 'UZ');
  assert.ok(f.calls[0]!.opts.invocation.allowedTools.includes('WebSearch'));
});

test('collect: передаётся сборщику как есть', async () => {
  const ctx = makeCtx();
  let seen: unknown = null;
  const ex = exec({
    runStage: fakeRunner(() => ({})).runStage,
    collector: {
      collect: async (c) => {
        seen = c;
        return { ok: true, output: { candidates: [cand('z')] } };
      },
    },
  });
  const r = await ex.collect(ctx);
  assert.ok(r.ok && r.output.candidates[0]!.id === 'z');
  assert.equal(seen, ctx);
});

// ───────── Сквозной прогон: оркестратор + боевые исполнители ─────────

/** Ответ экрана/перепроверки по схеме: цитата — реальная подстрока (≤300 знаков) первого фрагмента из входа. */
function screenAnswer(input: Record<string, unknown>, decide: (id: string) => 'material' | 'minor' | 'none' | 'unsure'): ScreenOutput {
  const items = (input['candidates'] as Array<{ id: string; fragments: string[] }>).map((c) => {
    assert.ok(c.fragments.length > 0 && c.fragments[0]!.length > 0, `${c.id}: во входе экрана есть фрагменты текста`);
    return {
      id: c.id,
      decision: decide(c.id),
      points: ['p. 1'],
      quote: c.fragments[0]!.slice(0, 300),
      reason: `decision for ${c.id}`,
      confidence: 'high' as const,
    };
  });
  return { country: 'UZ', mode: input['mode'] as ScreenOutput['mode'], items };
}

/** Абзац с банковскими словами: текст акта длиннее порога «нет текста» и с терминами для фрагментов. */
const BANK_PARA =
  'Tijorat banklarining aksiyadorlari va kuzatuv kengashi aʼzolari uchun talablar belgilanadi. Коммерческие банки обязаны раскрывать сведения об акционерах, ' +
  'владеющих более чем пятью процентами уставного капитала, а также о дивидендах и кредитах, выданных связанным лицам. Положение применяется ко всем ' +
  'банкам, получившим лицензию Центрального банка, и вступает в силу через три месяца после официального опубликования.';
/** Длинный текст без единого банковского слова (налоговая отчётность). */
const TAX_PARA =
  'Налогоплательщики представляют декларацию в электронной форме через личный кабинет. Сроки представления отчётности по налогу на имущество ' +
  'устанавливаются ежеквартально. Органы государственной налоговой службы проводят камеральную проверку в течение тридцати дней со дня ' +
  'представления декларации и уведомляют налогоплательщика о выявленных расхождениях. Настоящий порядок применяется с первого числа месяца.';

const CB_ISSUER = 'Правления Центрального банка Республики Узбекистан';

test('оркестратор с боевыми исполнителями: сбор → отбор → экран → анализ → цитаты → проверка → итог страны', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'rw-exec-e2e-'));
  const settings = settingsFor(ws);
  const cands = [
    cand('a1', 'A'), // канал А: в анализ без экрана
    cand('b1', 'B', { issuer: CB_ISSUER }), // экран: material → анализ
    cand('b2', 'B'), // отбор: irrelevant → только в verify как отброшенный
    cand('b3', 'B', { issuer: CB_ISSUER }), // экран: minor → «для сведения», без анализа
    cand('b4', 'B', { issuer: 'Налогового комитета Республики Узбекистан' }), // класс 3 без терминов → отброшен кодом
    cand('b5', 'B', { issuer: CB_ISSUER }), // экран: none (класс 1) → перепроверка → material
  ];
  // Страница акта содержит все цитаты карточки и банковский абзац → проверка цитат проходит, текст есть.
  const fetcher = fakeFetcher((url) => {
    const id = url.split('/').pop()!;
    const paras = id === 'b4' ? [TAX_PARA, TAX_PARA] : [...quotesOf(makeCard(id, 'UZ')), BANK_PARA];
    const body = `<html><body>${paras.map((q) => `<p>${q}</p>`).join('')}</body></html>`;
    return { ok: true, status: 200, url, body, contentType: 'text/html' };
  });
  const f = fakeRunner((c) => {
    if (c.stage === 'triage') {
      const out = decideAll(c.input);
      out.items.find((i) => i.id === 'b2')!.decision = 'irrelevant';
      out.items.find((i) => i.id === 'b2')!.reason_code = 'other_sector';
      out.items.find((i) => i.id === 'a1')!.decision = 'irrelevant'; // канал А код вернёт в relevant
      out.items.find((i) => i.id === 'a1')!.reason_code = 'other_sector';
      return out;
    }
    if (c.stage === 'screen' || c.stage === 'confirm') {
      const out = screenAnswer(c.input, (id) => (c.stage === 'confirm' ? 'material' : id === 'b3' ? 'minor' : id === 'b5' ? 'none' : 'material'));
      assert.deepEqual(c.opts.validate(out), { ok: true }, 'ответ экрана проходит схему screen');
      return out;
    }
    if (c.stage === 'analyze') return makeCard((c.input['candidate'] as { id: string }).id, 'UZ');
    if (c.stage === 'verify') return confirm(c.input);
    throw new Error(`неожиданный этап ${c.stage}`);
  });
  const executors = exec({
    runStage: f.runStage,
    fetcher,
    collector: { collect: async () => ({ ok: true, output: { candidates: cands } }) },
  });
  const orch = new Orchestrator({ executors, now: () => new Date(2026, 10, 17, 8, 0) });
  const r = await orch.start({ mode: 'dry_run', countries: [uz()], settings, gate: { canRun: false, canDryRun: true, message: '' }, skillsHash: 'h1' });
  assert.ok(r.ok && r.end === 'finished', JSON.stringify(r));
  const st = r.state.countries['UZ']!;
  assert.equal(st.status, 'changes');
  assert.deepEqual(Object.keys(st.acts), ['a1', 'b1', 'b5'], 'в анализ — канал А и material экрана');
  assert.equal(st.acts['a1']!.verdict, 'confirmed');
  assert.equal(r.state.skills_hash, 'h1');
  // Снимки — только отобранных (b2 отброшен отбором и не скачивается); канал А в экран не идёт.
  assert.deepEqual(fetcher.urls.sort(), ['a1', 'b1', 'b3', 'b4', 'b5'].map((id) => `https://lex.uz/docs/${id}`));
  assert.deepEqual(Object.keys(st.screen ?? {}).sort(), ['b1', 'b3', 'b4', 'b5'], 'канал А не проходит экран');
  assert.deepEqual(
    Object.fromEntries(Object.entries(st.screen!).map(([id, s]) => [id, [s.final, s.by]])),
    { b1: ['material', 'screen'], b3: ['minor', 'screen'], b4: ['dropped', 'code'], b5: ['material', 'confirm'] },
  );
  assert.deepEqual(f.calls.map((c) => c.stage), ['triage', 'screen', 'confirm', 'analyze', 'analyze', 'analyze', 'verify', 'verify']);

  // Экран: b4 решён кодом и в модель не попал; перепроверка видит прежнее решение и идёт не на haiku.
  const screenIn = f.calls[1]!.input as Record<string, any>;
  assert.equal(screenIn['mode'], 'screen');
  assert.deepEqual(screenIn['candidates'].map((x: { id: string }) => x.id), ['b1', 'b3', 'b5']);
  assert.deepEqual(screenIn['candidates'].map((x: { issuer_class: number }) => x.issuer_class), [1, 1, 1]);
  assert.match(f.calls[1]!.prompt, /^\/screen-act /);
  const confirmIn = f.calls[2]!.input as Record<string, any>;
  assert.equal(confirmIn['mode'], 'confirm');
  assert.deepEqual(confirmIn['candidates'].map((x: { id: string }) => x.id), ['b5']);
  assert.equal(confirmIn['candidates'][0].previous.decision, 'none');
  assert.notEqual(f.calls[2]!.opts.invocation.model, 'haiku');
  // Анализ: канал А и material, minor — нет.
  assert.deepEqual(f.calls.filter((c) => c.stage === 'analyze').map((c) => (c.input['candidate'] as { id: string }).id), ['a1', 'b1', 'b5']);

  assert.equal((f.calls[6]!.input as Record<string, any>)['rejected'].length, 0, 'пакет карточек без отброшенных');
  const verifyIn = f.calls[7]!.input as Record<string, any>;
  // VER-02: проверка видит отброшенных отбором (irrelevant) и экраном (none / класс 3 без терминов).
  assert.deepEqual(verifyIn['rejected'].map((x: { id: string }) => x.id), ['b2', 'b4']);
  assert.deepEqual(verifyIn['evidence_check'], []);
  const ev = JSON.parse(readFileSync(join(r.runDir, 'UZ', 'acts', 'b1', 'evidence-check.json'), 'utf8'));
  assert.equal(ev.ok, true);
  assert.ok(Array.isArray(ev.results));

  const result = JSON.parse(readFileSync(join(r.runDir, 'UZ', 'result.json'), 'utf8'));
  assert.deepEqual(result.items.map((x: { candidate_id: string }) => x.candidate_id), ['a1', 'b1', 'b5']);
  assert.deepEqual(result.for_information.map((x: { candidate_id: string }) => x.candidate_id), ['b3']);
  assert.deepEqual(result.unverified, []);
  const screenFile = JSON.parse(readFileSync(join(r.runDir, 'UZ', 'screen.json'), 'utf8'));
  assert.equal(screenFile.items.length, 4);
  assert.ok(st.usage.input > 0, 'расход учтён по процессам');
});


// ───────── Перевод письма (LNG-02/03, T-7) ─────────

const DIGEST_FIX = resolve(import.meta.dirname, '..', 'digest', 'fixtures');
const realCard = (n: string): Card => JSON.parse(readFileSync(join(DIGEST_FIX, `${n}.card.json`), 'utf8')) as Card;

function trCtx(o: { saveTranscripts?: boolean } = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'rw-tr-'));
  const runDir = join(ws, 'runs', 'r1');
  mkdirSync(runDir, { recursive: true });
  const s = settingsFor(ws);
  return { workspaceDir: ws, runDir, settings: { ...s, advanced: { ...s.advanced, saveTranscripts: !!o.saveTranscripts } } };
}

function translator(handler: (c: Call, n: number) => unknown | StageResult, extra: { batchSize?: number; noClaude?: boolean } = {}) {
  const f = fakeRunner(handler);
  const budget = { n: 0, async beforeProcess() { this.n++; } };
  const tr = createTranslator({
    schemasDir: SCHEMAS,
    claudeBin: () => (extra.noClaude ? null : '/usr/local/bin/claude'),
    claudeEnv: () => ({ PATH: '/usr/bin' }),
    runStage: f.runStage,
    budget,
    ...(extra.batchSize ? { batchSize: extra.batchSize } : {}),
  });
  return { tr, calls: f.calls, budget };
}

type TrItem = { id: string; text: string };
const itemsOf = (c: Call): TrItem[] => c.input['items'] as TrItem[];

// Фрагменты из реальных карточек 24/2 и 22/4.
const c24t = realCard('uz-24-2');
const c22t = realCard('uz-22-4');
const FRAGS = [...c24t.changes.slice(0, 3).map((c) => c.summary_en), c22t.changes[0]!.summary_en];
const RU_OK: Record<string, string> = {
  [FRAGS[0]!]: 'Комитет по аудиту: большинство членов не должны быть связанными лицами банка (кроме членства в совете), председатель — независимый член совета и не председатель совета.',
  [FRAGS[1]!]: 'Комитет по рискам обязателен для системно значимых банков (для остальных — по желанию).',
  [FRAGS[2]!]: 'Добавлены принципы: способность принимать объективные и независимые решения и достаточное число независимых членов совета.',
  [FRAGS[3]!]: 'Запросы авторизации и платёжные сообщения по розничным платежам в национальной валюте направляются через платёжный коммутатор ЦБ; P2P-переводы тоже.',
};

test('createTranslator: один вызов translate-ru, вход { glossary, items }, права только Read, перевод принят', async () => {
  const ctx = trCtx();
  const { tr, calls, budget } = translator((c) => ({ items: itemsOf(c).map((it) => ({ id: it.id, ru: RU_OK[it.text] ?? it.text })) }));
  const out = await tr(ctx, [...FRAGS, FRAGS[0]!, '  ']);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(calls.length, 1);
  assert.equal(budget.n, 1);
  const c = calls[0]!;
  assert.equal(c.stage, 'translate');
  assert.match(c.prompt, /^\/translate-ru \/.*\/runs\/r1\/translate\/input\.json$/);
  assert.deepEqual(itemsOf(c).map((i) => i.text), FRAGS, 'уникальные, без пустых');
  assert.deepEqual(itemsOf(c).map((i) => i.id), ['t1', 't2', 't3', 't4']);
  assert.equal((c.input['glossary'] as Record<string, string>)['supervisory board'], 'наблюдательный совет');
  assert.equal((c.input['glossary'] as Record<string, string>)['liquidity'], 'ликвидность');
  const inv = c.opts.invocation;
  assert.equal(inv.cwd, realpathSync(join(ctx.runDir, 'translate')));
  assert.deepEqual(inv.args[inv.args.indexOf('--tools') + 1], 'Read');
  assert.ok(!inv.args.some((a) => /WebFetch|WebSearch/.test(a)), 'без сети');
  assert.equal(inv.schema, 'translation');
  assert.deepEqual(out.output.rejected, []);
  assert.deepEqual(out.output.translations, RU_OK);
  assert.equal(out.processes?.length, 1);
  const rep = JSON.parse(readFileSync(join(ctx.runDir, 'translate', 'result.json'), 'utf8'));
  assert.equal(rep.total, 4);
  assert.equal(rep.translated, 4);
});

test('createTranslator T-7: подмена числа → фрагмент в rejected, в translations нет; пропущенный id — тоже', async () => {
  const ctx = trCtx();
  const target = FRAGS[1]!; // «… systemically important banks …» — чисел нет; добавим лишнее
  const withNum = 'Banks must keep settlement liquidity of at least 10% and report within 30 days.';
  const { tr } = translator((c) =>
    ({
      items: itemsOf(c)
        .filter((it) => it.text !== FRAGS[2])
        .map((it) => ({
          id: it.id,
          ru: it.text === withNum ? 'Банки должны держать ликвидность не менее 15% и отчитываться в течение 30 дней.' : it.text === target ? 'Комитет по рискам обязателен для 5 системно значимых банков.' : (RU_OK[it.text] ?? it.text),
        })),
    }),
  );
  const out = await tr(ctx, [...FRAGS, withNum]);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.output.translations[withNum], undefined);
  assert.equal(out.output.translations[target], undefined);
  assert.equal(out.output.translations[FRAGS[2]!], undefined);
  assert.equal(out.output.translations[FRAGS[0]!], RU_OK[FRAGS[0]!]);
  const rej = new Map(out.output.rejected.map((r) => [r.text, r.diffs]));
  assert.match(rej.get(withNum)!.join('; '), /Число «10»/);
  assert.match(rej.get(withNum)!.join('; '), /Число «15»/);
  assert.match(rej.get(target)!.join('; '), /«5» есть в русском переводе/);
  assert.deepEqual(rej.get(FRAGS[2]!), ['нет перевода в ответе модели']);
  // В письме — английский для отвергнутых (T-7 на уровне письма — build.test.ts).
  const { buildDigest } = await import('../digest/build.ts');
  const it = { candidate_id: c24t.candidate_id, key: 'k', channel: 'B' as const, kind: 'new' as const, confirmed: true, disputed_fields: [], rounds: 1, title_en: '', card_file: '' };
  const d = buildDigest(
    { runId: 'r1', date: '2026-11-20', checked: { ok: 1, total: 1 }, failures: [], countries: [{ code: 'UZ', nameRu: 'Узбекистан', result: { country: 'UZ', status: 'changes' as never, items: [it], duplicates: [], warnings: [], to_commit: [] }, cards: { [c24t.candidate_id]: c24t } }] },
    { lang: 'ru', translate: (s) => out.output.translations[s] ?? s },
  );
  assert.match(d.text, /🔴 п\. 16 — Комитет по аудиту/);
  assert.match(d.text, /🔴 п\. 19 — Risk committee is mandatory/);
});

test('createTranslator: пакеты по TRANSLATE_BATCH; провал одного пакета не теряет другие; лимит — провал сразу', async () => {
  assert.equal(TRANSLATE_BATCH, 60);
  const texts = Array.from({ length: 130 }, (_, i) => `Fragment number ${i + 1} about banks.`);
  const ru = (t: string) => t.replace('Fragment number', 'Фрагмент номер').replace('about banks.', 'о банках.');
  const ctx = trCtx();
  const fail: StageResult = { ok: false, failure: 'schema', message: 'Ответ не прошёл проверку схемы', attempts: 1, durationMs: 1, exitCode: 1, denied: [] };
  const { tr, calls } = translator((c, n) => (n === 2 ? fail : { items: itemsOf(c).map((it) => ({ id: it.id, ru: ru(it.text) })) }));
  const out = await tr(ctx, texts);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => itemsOf(c).length), [60, 60, 10]);
  assert.match(calls[1]!.prompt, /input-2\.json$/);
  assert.equal(itemsOf(calls[2]!)[0]!.id, 't121');
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(Object.keys(out.output.translations).length, 70);
  assert.equal(out.output.translations[texts[129]!], 'Фрагмент номер 130 о банках.');
  assert.equal(out.output.translations[texts[60]!], undefined);
  assert.equal(out.processes?.length, 3);
  const rep = JSON.parse(readFileSync(join(ctx.runDir, 'translate', 'result.json'), 'utf8'));
  assert.deepEqual(rep.failedBatches.map((b: { batch: number }) => b.batch), [2]);

  const limit: StageResult = { ok: false, failure: 'limit', message: 'Исчерпан лимит подписки Claude', resetsAt: '2026-11-20T15:00:00Z', attempts: 1, durationMs: 1, exitCode: 1, denied: [] };
  const l = translator(() => limit);
  const lo = await l.tr(trCtx(), texts);
  assert.equal(lo.ok, false);
  if (lo.ok) return;
  assert.equal(lo.failure, 'limit');
  assert.equal(lo.resetsAt, '2026-11-20T15:00:00Z');
  assert.equal(l.calls.length, 1);

  const all = translator(() => fail);
  const ao = await all.tr(trCtx(), FRAGS);
  assert.equal(ao.ok, false);
});

test('createTranslator: бюджет лимита на паузе → перевод без процесса, провал limit (письмо уйдёт с английскими фрагментами)', async () => {
  const f = fakeRunner(() => ({ items: [] }));
  const tr = createTranslator({
    schemasDir: SCHEMAS,
    claudeBin: () => '/usr/local/bin/claude',
    claudeEnv: () => ({ PATH: '/usr/bin' }),
    runStage: f.runStage,
    budget: {
      beforeProcess: async () => {
        throw new PauseSignal('2026-11-21T12:00:30.000Z', 'пауза по порогу');
      },
    },
  });
  const out = await tr(trCtx(), FRAGS);
  assert.equal(f.calls.length, 0);
  assert.ok(!out.ok && out.failure === 'limit' && out.resetsAt === '2026-11-21T12:00:30.000Z');
});

test('createTranslator: пусто — без вызова; нет claude — понятный провал', async () => {
  const e = translator(() => ({ items: [] }));
  const out = await e.tr(trCtx(), ['', '   ']);
  assert.deepEqual(out, { ok: true, output: { translations: {}, rejected: [] } });
  assert.equal(e.calls.length, 0);
  const n = translator(() => ({ items: [] }), { noClaude: true });
  const no = await n.tr(trCtx(), FRAGS);
  assert.equal(no.ok, false);
  if (!no.ok) assert.equal(no.message, NO_CLAUDE_MESSAGE);
});
