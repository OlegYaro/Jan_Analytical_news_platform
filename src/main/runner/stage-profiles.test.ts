import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Settings, StageKey } from '../../shared/types.ts';
import { STAGE_KEYS } from '../../shared/types.ts';
import {
  DISALLOWED_TOOLS,
  STAGE_MAX_TURNS,
  STAGE_SCHEMA,
  STAGE_SKILL,
  STRUCTURED_OUTPUT_TURNS,
  buildStageInvocation,
  normalizeDomain,
  readRule,
  withPromptSuffix,
} from './stage-profiles.ts';
import type { BuildStageInput } from './stage-profiles.ts';

const COUNTRY = '/Users/u/RegWatch/runs/2026-11-23_0800/UZ';
const INPUT = `${COUNTRY}/acts/3254-2/input.json`;
const SCHEMA = '{"type":"object"}';

function settings(over: Partial<Pick<Settings, 'preset' | 'advanced'>> = {}): Pick<Settings, 'preset' | 'advanced'> {
  return {
    preset: 'balanced',
    advanced: { stageModels: {}, timeoutsMin: {}, firstRunDays: 30, saveTranscripts: true, claudePath: '' },
    ...over,
  };
}

function build(stage: StageKey, over: Partial<BuildStageInput> = {}) {
  return buildStageInvocation({
    stage,
    settings: settings(),
    countryDir: COUNTRY,
    inputPath: INPUT,
    allowedDomains: ['lex.uz', 'cbu.uz'],
    schemaJson: SCHEMA,
    ...over,
  });
}

/** Значения после флага до следующего `--флага`. */
function flagValues(args: readonly string[], flag: string): string[] {
  const i = args.indexOf(flag);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < args.length && !args[j]!.startsWith('--'); j++) out.push(args[j]!);
  return out;
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
}

test('скиллы и схемы этапов', () => {
  assert.deepEqual(STAGE_SKILL, {
    news: 'news-sweep', triage: 'triage', screen: 'screen-act', confirm: 'screen-act', analyze: 'analyze-act', verify: 'verify-report',
    translate: 'translate-ru', srcCheck: 'verify-sources', srcDiscover: 'discover-sources',
  });
  assert.deepEqual(STAGE_SCHEMA, {
    news: 'news-sweep', triage: 'triage', screen: 'screen', confirm: 'screen', analyze: 'card', verify: 'verification',
    translate: 'translation', srcCheck: 'verify-sources', srcDiscover: 'discover-sources',
  });
});

test('промпт: -p "/<skill> <абсолютный путь>" первыми аргументами', () => {
  for (const s of STAGE_KEYS) {
    const inv = build(s);
    assert.equal(inv.args[0], '-p');
    assert.equal(inv.args[1], `/${STAGE_SKILL[s]} ${INPUT}`);
    assert.equal(inv.prompt, inv.args[1]);
    assert.equal(inv.skill, STAGE_SKILL[s]);
  }
});

test('каждое правило --allowedTools — отдельный элемент args', () => {
  for (const s of STAGE_KEYS) {
    const inv = build(s);
    const vals = flagValues(inv.args, '--allowedTools');
    assert.deepEqual(vals, inv.allowedTools, s);
    assert.ok(vals.length > 0, s);
    for (const v of vals) {
      // Ни одного списка через запятую/пробел в одном элементе.
      assert.ok(!v.includes(','), `${s}: ${v}`);
      assert.match(v, /^[A-Za-z]+(\(.+\))?$/, `${s}: ${v}`);
    }
    // --allowedTools встречается один раз и стоит последним (вариадический флаг).
    assert.equal(inv.args.filter((a) => a === '--allowedTools').length, 1);
    assert.equal(inv.args.indexOf('--allowedTools') + 1 + vals.length, inv.args.length);
  }
});

test('Bash, Agent, Write, Edit всегда в --disallowedTools; dontAsk всегда', () => {
  for (const s of STAGE_KEYS) {
    for (const transcripts of [true, false]) {
      const inv = build(s, { transcripts, allowedDomains: [] });
      const dis = (flagValue(inv.args, '--disallowedTools') ?? '').split(',');
      for (const t of ['Bash', 'Agent', 'Task', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) assert.ok(dis.includes(t), `${s}: ${t}`);
      assert.deepEqual(dis, [...DISALLOWED_TOOLS]);
      assert.equal(flagValue(inv.args, '--permission-mode'), 'dontAsk');
      // Запрещённые не попадают ни в --tools, ни в --allowedTools.
      const tools = (flagValue(inv.args, '--tools') ?? '').split(',');
      for (const t of DISALLOWED_TOOLS) {
        assert.ok(!tools.includes(t), `${s}: ${t} в --tools`);
        assert.ok(!inv.allowedTools.some((r) => r === t || r.startsWith(`${t}(`)), `${s}: ${t} в allowed`);
      }
    }
  }
});

test('--setting-sources project и --strict-mcp-config есть, --restricted нет', () => {
  for (const s of STAGE_KEYS) {
    const inv = build(s);
    assert.equal(flagValue(inv.args, '--setting-sources'), 'project');
    assert.ok(inv.args.includes('--strict-mcp-config'));
    assert.ok(!inv.args.includes('--restricted'));
    assert.equal(flagValue(inv.args, '--output-format'), 'stream-json');
    assert.ok(inv.args.includes('--verbose'));
    assert.equal(flagValue(inv.args, '--json-schema'), SCHEMA);
  }
});

test('домены → WebFetch(domain:…) по одному правилу на домен (analyze/verify/srcCheck)', () => {
  for (const s of ['analyze', 'verify', 'srcCheck'] as const) {
    const inv = build(s, { allowedDomains: ['lex.uz', 'https://www.CBU.uz/ru/', 'lex.uz', 'bad domain', 'x),Bash(', '*.evil.com'] });
    const wf = inv.allowedTools.filter((r) => r.startsWith('WebFetch'));
    assert.deepEqual(wf, ['WebFetch(domain:lex.uz)', 'WebFetch(domain:www.cbu.uz)'], s);
    assert.ok(!inv.allowedTools.includes('WebFetch'), `${s}: свободный WebFetch`);
    assert.ok((flagValue(inv.args, '--tools') ?? '').split(',').includes('WebFetch'));
  }
});

test('пустой список доменов → WebFetch не выдаётся вовсе', () => {
  for (const s of ['analyze', 'verify', 'srcCheck'] as const) {
    for (const allowedDomains of [[], ['not a domain'], undefined]) {
      const inv = build(s, { allowedDomains });
      assert.ok(!inv.allowedTools.some((r) => r.startsWith('WebFetch')), s);
      assert.ok(!(flagValue(inv.args, '--tools') ?? '').split(',').includes('WebFetch'), s);
    }
  }
});

test('права этапов по таблице docs/02 §6', () => {
  const tools = (s: StageKey) => (flagValue(build(s).args, '--tools') ?? '').split(',').sort();
  assert.deepEqual(tools('news'), ['Read', 'WebFetch', 'WebSearch']);
  assert.deepEqual(tools('triage'), ['Read']);
  assert.deepEqual(tools('screen'), ['Read']);
  assert.deepEqual(tools('confirm'), ['Read']);
  assert.deepEqual(tools('analyze'), ['Read', 'WebFetch']);
  assert.deepEqual(tools('verify'), ['Read', 'WebFetch']);
  assert.deepEqual(tools('translate'), ['Read']);
  assert.deepEqual(tools('srcCheck'), ['Read', 'WebFetch', 'WebSearch']);
  assert.deepEqual(tools('srcDiscover'), ['Read', 'WebFetch', 'WebSearch']);

  assert.deepEqual(build('news').allowedTools, [readRule(COUNTRY, true), 'WebFetch', 'WebSearch']);
  assert.deepEqual(build('triage').allowedTools, [readRule(COUNTRY, true)]);
  // Экран и подтверждение видят только фрагменты из input.json: без сети (SCR-01).
  assert.deepEqual(build('screen').allowedTools, [readRule(COUNTRY, true)]);
  assert.deepEqual(build('confirm').allowedTools, [readRule(COUNTRY, true)]);
  assert.deepEqual(build('translate').allowedTools, [readRule(COUNTRY, true)]);
  assert.deepEqual(build('srcCheck').allowedTools, [
    readRule(COUNTRY, true), 'WebFetch(domain:lex.uz)', 'WebFetch(domain:cbu.uz)', 'WebSearch',
  ]);
  assert.deepEqual(build('srcDiscover').allowedTools, [readRule(COUNTRY, true), 'WebFetch', 'WebSearch']);
});

test('Read: абсолютный путь с двойной косой, cwd = папка страны, input вне папки — отдельное правило', () => {
  assert.equal(readRule('/a/b', true), 'Read(//a/b/**)');
  assert.equal(readRule('/a/b/in.json', false), 'Read(//a/b/in.json)');
  const inv = build('analyze');
  assert.equal(inv.cwd, COUNTRY);
  assert.deepEqual(inv.allowedTools.filter((r) => r.startsWith('Read')), [`Read(/${COUNTRY}/**)`]);

  const outside = '/Users/u/RegWatch/runs/2026-11-23_0800/translate/input.json';
  const inv2 = build('translate', { inputPath: outside });
  assert.deepEqual(inv2.allowedTools, [`Read(/${COUNTRY}/**)`, `Read(/${outside})`]);
  assert.equal(inv2.args[1], `/translate-ru ${outside}`);

  assert.throws(() => build('triage', { inputPath: 'rel/input.json' }));
  assert.throws(() => build('triage', { countryDir: 'rel' }));
});

test('пресет меняет модель', () => {
  assert.equal(build('triage', { settings: settings({ preset: 'economy' }) }).model, 'haiku');
  assert.equal(build('triage', { settings: settings({ preset: 'balanced' }) }).model, 'sonnet');
  assert.equal(build('triage', { settings: settings({ preset: 'max' }) }).model, 'opus');
  assert.equal(build('analyze', { settings: settings({ preset: 'economy' }) }).model, 'sonnet');
  assert.equal(build('translate', { settings: settings({ preset: 'max' }) }).model, 'sonnet');
  const inv = build('analyze');
  assert.equal(inv.model, 'opus');
  assert.equal(flagValue(inv.args, '--model'), 'opus');
});

test('модель из настроек «Дополнительно» перекрывает пресет; пустая строка — нет', () => {
  const adv = settings().advanced;
  const inv = build('analyze', { settings: settings({ advanced: { ...adv, stageModels: { analyze: 'sonnet' } } }) });
  assert.equal(inv.model, 'sonnet');
  assert.equal(flagValue(inv.args, '--model'), 'sonnet');
  assert.equal(build('analyze', { settings: settings({ advanced: { ...adv, stageModels: { analyze: '' } } }) }).model, 'opus');
});

test('--max-turns = таблица + 2 на structured output', () => {
  const table = { news: 15, triage: 10, screen: 10, confirm: 10, analyze: 30, verify: 30, translate: 8, srcCheck: 30, srcDiscover: 30 };
  assert.deepEqual(STAGE_MAX_TURNS, table);
  assert.equal(STRUCTURED_OUTPUT_TURNS, 2);
  for (const s of STAGE_KEYS) {
    const inv = build(s);
    assert.equal(inv.maxTurns, table[s] + 2);
    assert.equal(flagValue(inv.args, '--max-turns'), String(table[s] + 2));
  }
});

test('таймаут этапа из пресета и из настроек', () => {
  assert.equal(build('triage').timeoutMs, 5 * 60_000);
  assert.equal(build('analyze').timeoutMs, 10 * 60_000);
  const adv = settings().advanced;
  assert.equal(build('analyze', { settings: settings({ advanced: { ...adv, timeoutsMin: { analyze: 15 } } }) }).timeoutMs, 15 * 60_000);
});

test('transcripts=false → --no-session-persistence; по умолчанию — из настроек', () => {
  assert.ok(build('triage', { transcripts: false }).args.includes('--no-session-persistence'));
  assert.ok(!build('triage', { transcripts: true }).args.includes('--no-session-persistence'));
  const adv = settings().advanced;
  assert.ok(build('triage', { settings: settings({ advanced: { ...adv, saveTranscripts: false } }) }).args.includes('--no-session-persistence'));
  assert.ok(!build('triage').args.includes('--no-session-persistence'));
});

test('normalizeDomain', () => {
  assert.equal(normalizeDomain(' Lex.UZ '), 'lex.uz');
  assert.equal(normalizeDomain('https://lex.uz/docs/1'), 'lex.uz');
  assert.equal(normalizeDomain('lex.uz.'), 'lex.uz');
  for (const bad of ['', 'localhost', 'a b.uz', 'x),Bash(', '*.lex.uz', 'lex.uz/path', 'lex.uz,cbu.uz']) {
    assert.equal(normalizeDomain(bad), null, bad);
  }
});

test('withPromptSuffix меняет только промпт в args[1]', () => {
  const inv = build('triage');
  const r = withPromptSuffix(inv, '\n\nfix it');
  assert.equal(r.args[1], `${inv.prompt}\n\nfix it`);
  assert.deepEqual(r.args.slice(2), inv.args.slice(2));
  assert.equal(r.prompt, inv.prompt);
  assert.equal(inv.args[1], inv.prompt);
});
