// Заглушки исполнителей этапов для тестов оркестратора (и дочернего процесса T-18).
// Не используются в приложении.

import type { Country, Settings } from '../../../shared/types.ts';
import type { Usage } from '../../../shared/run-types.ts';
import type { Card, Fact, NewsSweep, TriageOutput, Verification } from '../../../shared/schema-types.ts';
import type { Candidate, CollectOutput, ModelStage, Outcome } from '../../../shared/pipeline-types.ts';
import type { GateStatus } from '../../mail-gate.ts';
import { defaultSettings } from '../../settings/defaults.ts';
import type { EvidenceResult, LeadHint, RejectedCandidate, ReviewerNotes, StageContext, StageExecutors, VerifyCardInput } from '../orchestrator.ts';

export const OPEN_GATE: GateStatus = { canRun: true, canDryRun: true, message: '' };

export const STUB_USAGE: Partial<Usage> = { input: 100, output: 10, cache_read: 0, cache_write: 0, cost_usd: 0.01 };

/** Успешный ответ модели с расходом и записью процесса. */
export function ok<T>(stage: ModelStage, output: T, act?: string): Outcome<T> {
  return {
    ok: true,
    output,
    usage: STUB_USAGE,
    processes: [{ stage, model: 'stub', durationMs: 5, tokens: STUB_USAGE, exitCode: 0, attempts: 1, ...(act ? { act } : {}) }],
  };
}

/** Провал этапа (как из claude-runner). */
export function fail<T>(stage: ModelStage, failure: string, message: string, extra: { resetsAt?: string } = {}): Outcome<T> {
  return {
    ok: false,
    failure,
    message,
    ...extra,
    processes: [{ stage, model: 'stub', durationMs: 5, exitCode: 1, failure }],
  };
}

export function country(code: string, active = true): Country {
  return { code, name: code, languages: ['ru'], active, sources: [], watchedActs: [], lastCheckedAt: null, lastRunSummary: '' };
}

export function settingsFor(workspaceDir: string, patch: Partial<Settings> = {}): Settings {
  return { ...defaultSettings('/home/test'), workspaceDir, newsEnabled: false, ...patch };
}

export function cand(id: string, channel: Candidate['channel'] = 'B', extra: Partial<Candidate> = {}): Candidate {
  return {
    id,
    key: `reg:${id}`,
    title_original: `Act ${id}`,
    issuer: 'Central Bank',
    date: '2026-11-10',
    doc_type: 'resolution',
    url: `https://lex.uz/docs/${id}`,
    snippet: '',
    channel,
    ...extra,
  };
}

const F = <T extends string | number = string>(value: T | 'unknown'): Fact<T> => ({ value, quote: String(value), url: 'https://lex.uz/docs/x' });

/** Полная карточка по схеме docs/04 §3. */
export function makeCard(id: string, code: string, o: { stage?: Card['stage']; effective?: string; regNo?: string } = {}): Card {
  return {
    candidate_id: id,
    country: code,
    act: {
      type: F('Central Bank Board resolution'),
      issuer: F('Central Bank'),
      number: F('24/2'),
      title_original: F(`Act ${id}`),
      title_en: `Title ${id}`,
      adoption_date: F('2026-09-17'),
      registration_number: F(o.regNo ?? id),
      registration_date: F('unknown'),
      publication_date: F('2026-10-12'),
      effective_date: F(o.effective ?? '2027-01-13'),
      transition_period: { exists: F<'yes' | 'no'>('no'), details: '' },
      original_language: 'uz',
      official_russian_text: 'no',
    },
    stage: o.stage ?? 'published',
    update_of: null,
    amends: { base_act_title: F('Base'), base_act_number: F('3254'), base_act_url: '', prior_amendments: [] },
    scope: { applies_to: F('commercial banks'), not_applies_to: F('unknown') },
    change_count: { annex_items: F<number>(10), legal_base_marks: F<number>(14), explanation: '' },
    changes: [],
    links: { amending_act: '', current_version: '', version_on_effective_date: '' },
    unknowns: [],
    notes: '',
  };
}

export function triageAll(code: string, cands: Candidate[], decision: 'relevant' | 'borderline' = 'relevant'): TriageOutput {
  return { country: code, items: cands.map((c) => ({ id: c.id, decision, reason_code: null, reason_text: '', confidence: 'high' as const })) };
}

export function confirmAll(code: string, cards: VerifyCardInput[]): Verification {
  return {
    country: code,
    cards: cards.map((c) => ({ candidate_id: c.candidate.id, fields: [{ field: 'act.number', status: 'ok' as const, comment: '' }], verdict: 'confirmed' as const })),
    returned: [],
    watched_acts_check: [],
  };
}

export interface Call {
  stage: 'collect' | 'news' | 'resolveLead' | 'triage' | 'analyze' | 'checkEvidence' | 'verify';
  country: string;
  act?: string;
  notes?: ReviewerNotes;
  retry?: string;
  cards?: string[];
  rejected?: string[];
}

type MaybeAsync<T> = T | Promise<T>;

export interface HarnessOptions {
  candidates?: Record<string, Candidate[]>;
  collect?: (ctx: StageContext) => MaybeAsync<Outcome<CollectOutput>>;
  news?: (ctx: StageContext, known: Candidate[]) => MaybeAsync<Outcome<NewsSweep>>;
  resolveLead?: (ctx: StageContext, lead: LeadHint) => MaybeAsync<Candidate | null>;
  /** n — номер вызова triage для этой страны (с 1). */
  triage?: (ctx: StageContext, cands: Candidate[], n: number) => MaybeAsync<Outcome<TriageOutput>>;
  /** n — номер вызова analyze для этого акта (с 1). */
  analyze?: (ctx: StageContext, cand: Candidate, notes: ReviewerNotes | undefined, n: number) => MaybeAsync<Outcome<Card>>;
  checkEvidence?: (ctx: StageContext, cand: Candidate, card: Card, n: number) => MaybeAsync<EvidenceResult>;
  /** n — номер вызова verify для этой страны (с 1). */
  verify?: (ctx: StageContext, cards: VerifyCardInput[], rejected: RejectedCandidate[], n: number) => MaybeAsync<Outcome<Verification>>;
}

export interface Harness {
  executors: StageExecutors;
  calls: Call[];
  count(stage: Call['stage'], country?: string, act?: string): number;
}

/** Заглушки с журналом вызовов. По умолчанию: всё relevant, все карточки подтверждены. */
export function makeHarness(o: HarnessOptions = {}): Harness {
  const calls: Call[] = [];
  const count = (stage: Call['stage'], c?: string, act?: string): number =>
    calls.filter((x) => x.stage === stage && (c === undefined || x.country === c) && (act === undefined || x.act === act)).length;

  const executors: StageExecutors = {
    async collect(ctx) {
      calls.push({ stage: 'collect', country: ctx.country.code });
      if (o.collect) return o.collect(ctx);
      return { ok: true, output: { candidates: o.candidates?.[ctx.country.code] ?? [] } };
    },
    async triage(ctx, cands) {
      calls.push({ stage: 'triage', country: ctx.country.code, ...(ctx.retry ? { retry: ctx.retry.message } : {}) });
      const n = count('triage', ctx.country.code);
      if (o.triage) return o.triage(ctx, cands, n);
      return ok('triage', triageAll(ctx.country.code, cands));
    },
    async analyze(ctx, c, notes) {
      calls.push({ stage: 'analyze', country: ctx.country.code, act: c.id, ...(notes ? { notes } : {}) });
      const n = count('analyze', ctx.country.code, c.id);
      if (o.analyze) return o.analyze(ctx, c, notes, n);
      return ok('analyze', makeCard(c.id, ctx.country.code), c.id);
    },
    async verify(ctx, cards, rejected) {
      calls.push({ stage: 'verify', country: ctx.country.code, cards: cards.map((c) => c.candidate.id), rejected: rejected.map((r) => r.candidate.id) });
      const n = count('verify', ctx.country.code);
      if (o.verify) return o.verify(ctx, cards, rejected, n);
      return ok('verify', confirmAll(ctx.country.code, cards));
    },
  };
  if (o.news) {
    const news = o.news;
    executors.news = async (ctx, known) => {
      calls.push({ stage: 'news', country: ctx.country.code });
      return news(ctx, known);
    };
  }
  if (o.resolveLead) {
    const rl = o.resolveLead;
    executors.resolveLead = async (ctx, lead) => {
      calls.push({ stage: 'resolveLead', country: ctx.country.code });
      return rl(ctx, lead);
    };
  }
  if (o.checkEvidence) {
    const ce = o.checkEvidence;
    executors.checkEvidence = async (ctx, c, card) => {
      calls.push({ stage: 'checkEvidence', country: ctx.country.code, act: c.id });
      return ce(ctx, c, card, count('checkEvidence', ctx.country.code, c.id));
    };
  }
  return { executors, calls, count };
}
