#!/usr/bin/env node
// Риск фазы 3: принимает ли `claude --json-schema` полную схему card.json (maxLength, вложенность,
// anyOf с const/pattern) и проходит ли structured_output нашу ajv-проверку ПОЛНОЙ схемой.
// Реальный вызов claude (тратит немного лимита haiku): 1 вызов.
// Запуск вручную: node scripts/schema-card-check.mjs
//
// Временная папка с input.txt — ВЫДУМАННЫЙ тестовый «акт» (не реальный документ). Одно «изменение»
// нарочно длиннее 300 символов: так видно, что модель/CLI делают с maxLength=300 у quote.

import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClaudeEnv, findClaude } from '../src/main/env.ts';
import { createValidator, schemaForCli } from '../src/main/schemas.ts';
import { parseRateLimitEvent } from '../src/main/runner/claude-runner.ts';

const ok = (s) => console.log(`✅ ${s}`);
const bad = (s) => console.log(`❌ ${s}`);
const info = (s) => console.log(`   ${s}`);

const schemasDir = join(import.meta.dirname, '..', 'schemas');
const TIMEOUT_MS = 240_000;

const INPUT = [
  'TEST FIXTURE: FICTIONAL TEXT FOR SOFTWARE TESTING. THIS IS NOT A REAL LEGAL ACT.',
  'Resolution No. 777-T of the Test Ministry of Imaginary Affairs was adopted on 3 March 2026 and enters into force on 1 June 2026.',
  'Change 1: in paragraph 4 of the Regulation on Sample Registries, the words "ten working days" are replaced with the words "five working days", so that every applicant who submits a complete set of documents to the registry through the single electronic portal, by post, or in person at any regional office of the Test Ministry receives a written decision on the application, together with the reasons for any refusal and the procedure for appeal, within the shortened period.',
  'Change 2: paragraph 9 of the same Regulation is repealed.',
].join('\n');

const PROMPT = 'Read input.txt and return the card; use "unknown" where the text does not show a value; quotes must be verbatim';

const schemaJson = schemaForCli('card', schemasDir);
const validate = createValidator('card', schemasDir);

const env = await buildClaudeEnv();
const bin = findClaude({ env });
if (!bin) {
  bad('Claude Code не найден');
  process.exit(1);
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'rw-card-')));
writeFileSync(join(root, 'input.txt'), INPUT + '\n');

const args = [
  '-p',
  PROMPT,
  '--model',
  'haiku',
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-mode',
  'dontAsk',
  '--setting-sources',
  'project',
  '--strict-mcp-config',
  '--no-session-persistence',
  '--max-turns',
  '8',
  '--json-schema',
  schemaJson,
  '--disallowedTools',
  'Bash,Agent,Task,Write,Edit,MultiEdit,NotebookEdit',
  '--tools',
  'Read',
  '--allowedTools',
  'Read',
];

console.log(`claude: ${bin}; схема card.json: ${schemaJson.length} символов (полная, без упрощений)`);
const t0 = Date.now();
const run = await new Promise((resolve) => {
  const child = spawn(bin, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let buf = '';
  let stderr = '';
  const events = [];
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }, TIMEOUT_MS);
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        stderr += `[stdout не JSON] ${line.slice(0, 200)}\n`;
      }
    }
  });
  child.stderr.on('data', (d) => (stderr += d));
  child.on('error', (e) => (stderr += String(e)));
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve({ code, stderr, events, timedOut });
  });
});
const sec = (Date.now() - t0) / 1000;
rmSync(root, { recursive: true, force: true });

let failed = 0;
const check = (cond, text) => (cond ? ok(text) : (bad(text), failed++));

const init = run.events.find((e) => e.type === 'system' && e.subtype === 'init');
const result = [...run.events].reverse().find((e) => e.type === 'result');
const toolUses = [];
const toolErrors = [];
const idName = new Map();
for (const e of run.events) {
  if (e.type === 'assistant')
    for (const b of e.message?.content ?? [])
      if (b.type === 'tool_use') {
        toolUses.push(b.name);
        idName.set(b.id, b.name);
      }
  if (e.type === 'user')
    for (const b of e.message?.content ?? [])
      if (b.type === 'tool_result' && b.is_error)
        toolErrors.push(`${idName.get(b.tool_use_id) ?? '?'}: ${JSON.stringify(b.content).slice(0, 400)}`);
}

console.log(`\nвремя ${sec.toFixed(1)} с, код выхода ${run.code}${run.timedOut ? ' (УБИТ ПО ТАЙМАУТУ)' : ''}`);
info(`инструменты сессии: ${JSON.stringify(init?.tools ?? null)}; вызовы: ${JSON.stringify(toolUses)}`);
if (toolErrors.length) for (const t of toolErrors) info(`ошибка инструмента → ${t}`);
if (run.stderr.trim()) info(`stderr: ${run.stderr.trim().slice(0, 600)}`);

// Лимит подписки: модель не отвечала, о схеме ничего не известно → проверка не выполнена.
// Признаки как в claude-runner.ts: окно лимита «отказано», HTTP 429 или текст про лимит в result.
const limitEv = run.events.filter((e) => e.type === 'rate_limit_event').map((e) => parseRateLimitEvent(e)).find((r) => r.rejected);
const limitText = result?.is_error && /(rate[ _-]?limit|usage limit|hit your .*limit|5-hour limit|weekly limit)/i.test(String(result.result ?? ''));
if (limitEv || limitText || result?.api_error_status === 429) {
  console.log(
    `\n⏸ Лимит подписки исчерпан: ${String(result?.result ?? '').slice(0, 200)}${limitEv?.resetsAt ? ` (сброс ${limitEv.resetsAt})` : ''}`,
  );
  console.log('   Модель не вызывалась, схема не проверена. Повторите после сброса лимита.');
  process.exit(2);
}

// (а) CLI принял схему.
const schemaErr = /schema/i.test(run.stderr) && !result;
check(!run.timedOut && !schemaErr && !!result, `(а) CLI принял схему: ${result ? `result.subtype=${result.subtype}` : 'события result нет'}`);

// (б) structured_output есть.
const out = result?.structured_output;
check(out !== undefined && out !== null, '(б) structured_output есть');

// (г) ходы/токены/стоимость.
if (result) {
  const u = result.usage ?? {};
  info(
    `(г) ходов ${result.num_turns}; токены: вход ${u.input_tokens ?? '?'}, кэш-создание ${u.cache_creation_input_tokens ?? '?'}, кэш-чтение ${u.cache_read_input_tokens ?? '?'}, выход ${u.output_tokens ?? '?'}; стоимость $${result.total_cost_usd ?? '?'}; модели ${Object.keys(result.modelUsage ?? {}).join(', ')}`,
  );
  if (result.is_error) info(`result.is_error: ${String(result.result ?? '').slice(0, 300)}`);
}

if (out) {
  // (в) ajv полной схемой.
  const v = validate(out);
  check(v.ok, `(в) ajv (полная card.json): ${v.ok ? 'проходит' : v.error}`);

  // (д) quote и maxLength, anyOf-значения.
  const quotes = [];
  const anyOfVals = [];
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const src = norm(INPUT);
  const walk = (x, path) => {
    if (Array.isArray(x)) return x.forEach((y, i) => walk(y, `${path}/${i}`));
    if (x && typeof x === 'object') {
      for (const [k, y] of Object.entries(x)) {
        if (k === 'quote' && typeof y === 'string') quotes.push({ path: `${path}/quote`, len: y.length, verbatim: y === '' || src.includes(norm(y)) });
        if (k === 'value' && /date|annex_items|legal_base_marks/.test(path)) anyOfVals.push(`${path}/value=${JSON.stringify(y)}`);
        if (k === 'date') anyOfVals.push(`${path}/date=${JSON.stringify(y)}`);
        walk(y, `${path}/${k}`);
      }
    }
  };
  walk(out, '');
  const maxLen = Math.max(0, ...quotes.map((q) => q.len));
  const over = quotes.filter((q) => q.len > 300);
  const notVerbatim = quotes.filter((q) => !q.verbatim);
  info(`(д) цитат ${quotes.length}, самая длинная ${maxLen} симв.; длиннее 300: ${over.length ? over.map((q) => `${q.path} (${q.len})`).join(', ') : 'нет'}`);
  info(`    не дословные (нет в input.txt): ${notVerbatim.length ? notVerbatim.map((q) => q.path).join(', ') : 'нет'}`);
  const changeQuotes = (out.changes ?? []).map((c) => `#${c.n} ${c.kind} ${c.quote.length} симв.: ${JSON.stringify(c.quote.slice(0, 90))}${c.quote.length > 90 ? '…' : ''}`);
  for (const c of changeQuotes) info(`    changes ${c}`);
  info(`    anyOf-значения: ${anyOfVals.join('; ')}`);
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const badDates = anyOfVals.filter((s) => /_date\/value=|\/date=/.test(s)).filter((s) => {
    const val = JSON.parse(s.slice(s.indexOf('=') + 1));
    return !(val === 'unknown' || (typeof val === 'string' && dateRe.test(val)));
  });
  check(badDates.length === 0, `(д) даты: ГГГГ-ММ-ДД или "unknown"${badDates.length ? ` — нарушения: ${badDates.join('; ')}` : ''}`);
  check(
    out.act?.adoption_date?.value === '2026-03-03' && out.act?.effective_date?.value === '2026-06-01' && out.act?.registration_date?.value === 'unknown',
    `(д) факты: принят ${out.act?.adoption_date?.value}, в силе ${out.act?.effective_date?.value}, регистрация ${out.act?.registration_date?.value}; номер ${JSON.stringify(out.act?.number?.value)}; изменений ${out.changes?.length}`,
  );
  check(over.length === 0, `(д) maxLength=300 у quote соблюдён`);
}

console.log(failed === 0 ? '\n✅ Полная схема card.json работает в CLI и проходит ajv' : `\n❌ Не пройдено проверок: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
