import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { SCHEMA_NAMES, createValidator, loadSchema, schemaForCli } from './schemas.ts'
import type { Card, Translation, TriageOutput, Verification } from '../shared/schema-types.ts'

const dir = join(import.meta.dirname, '..', '..', 'schemas')
const v = (n: (typeof SCHEMA_NAMES)[number]) => createValidator(n, dir)
const clone = <T>(x: T): T => structuredClone(x)

const U = { value: 'unknown', quote: '', url: '' } as const
const AMEND = 'https://lex.uz/docs/8530799'

// Тест формы, не фактов: цитаты — заглушки, не реальные выдержки из акта.
const FIXTURE_FORM_ONLY: Card = {
  candidate_id: 'lexuz-8530799',
  country: 'UZ',
  act: {
    type: { value: 'Central Bank Board resolution', quote: 'Markaziy bank Boshqaruvi qarori', url: AMEND },
    issuer: { value: 'Central Bank of the Republic of Uzbekistan', quote: 'Oʻzbekiston Respublikasi Markaziy banki', url: AMEND },
    number: { value: '24/2', quote: '24/2-son', url: AMEND },
    title_original: { value: 'Tijorat banklarida korporativ boshqaruv toʻgʻrisidagi nizomga oʻzgartirishlar', quote: 'korporativ boshqaruv toʻgʻrisidagi nizom', url: AMEND },
    title_en: 'Amendments to the Regulation on corporate governance in commercial banks',
    adoption_date: { value: '2026-09-17', quote: '2026-yil 17-sentabr', url: AMEND },
    registration_number: { value: '3254-2', quote: 'roʻyxat raqami 3254-2', url: AMEND },
    registration_date: { value: '2026-10-09', quote: '2026-yil 9-oktabr', url: AMEND },
    publication_date: { value: '2026-10-12', quote: '2026-yil 12-oktabr', url: AMEND },
    effective_date: { value: '2027-01-13', quote: 'rasmiy eʼlon qilingan kundan boshlab uch oy', url: AMEND },
    transition_period: { exists: { value: 'no', quote: 'uch oy oʻtgach kuchga kiradi', url: AMEND }, details: 'In force 3 months after official publication; no transition period.' },
    original_language: 'uz',
    official_russian_text: 'no',
  },
  stage: 'published',
  update_of: null,
  amends: {
    base_act_title: { value: 'Regulation on corporate governance in commercial banks', quote: 'Tijorat banklarida korporativ boshqaruv toʻgʻrisidagi nizom', url: 'https://lex.uz/docs/-4888804' },
    base_act_number: { value: '3254', quote: '3254-son', url: 'https://lex.uz/docs/-4888804' },
    base_act_url: 'https://lex.uz/docs/-4888804',
    prior_amendments: [{ number: '3254-1', date: '2026-07-08', url: 'https://lex.uz/docs/-4888804' }],
  },
  scope: {
    applies_to: { value: 'Commercial banks incl. microfinance and Islamic banking banks', quote: 'tijorat banklari', url: AMEND },
    not_applies_to: U,
  },
  change_count: {
    annex_items: { value: 10, quote: 'ilova 10 band', url: AMEND },
    legal_base_marks: { value: 14, quote: 'huquqiy asos belgilari', url: AMEND },
    explanation: 'Points 3 and 53 carry three legal-base marks each.',
  },
  changes: [
    ['Point 2', 'rewritten', 'not_significant', 'low'],
    ['Point 3', 'rewritten', 'less_significant', 'low'],
    ['Point 5', 'added', 'less_significant', 'low'],
    ['Point 8', 'added', 'significant', 'high'],
    ['Point 11', 'added', 'not_significant', 'low'],
    ['Point 15', 'added', 'not_significant', 'low'],
    ['Point 16', 'rewritten', 'significant', 'high'],
    ['Point 19', 'rewritten', 'significant', 'medium'],
    ['Chapter 8¹ (points 50¹–50⁵)', 'new_chapter', 'less_significant', 'medium'],
    ['Point 53', 'added', 'less_significant', 'low'],
  ].map(([location, kind, significance, difficulty], i) => ({
    n: i + 1,
    location: location as string,
    kind: kind as 'rewritten' | 'added' | 'new_chapter',
    summary_en: `Change ${i + 1}`,
    significance: significance as 'significant' | 'less_significant' | 'not_significant',
    significance_reason: 'Form-only fixture reason',
    implementation_difficulty: difficulty as 'low' | 'medium' | 'high',
    difficulty_reason: 'Form-only fixture reason',
    quote: 'qisqa namuna',
    url: AMEND,
  })),
  links: {
    amending_act: AMEND,
    current_version: 'https://www.lex.uz/docs/-4888804',
    version_on_effective_date: 'lex.uz/docs/-4888804?ONDATE=13.01.2027',
  },
  unknowns: ['scope.not_applies_to'],
  notes: '',
}

const TRIAGE: TriageOutput = {
  country: 'UZ',
  items: [
    { id: 'a', decision: 'relevant', reason_code: null, reason_text: 'Amends bank regulation', confidence: 'high' },
    { id: 'b', decision: 'irrelevant', reason_code: 'other_sector', reason_text: 'Agriculture', confidence: 'medium' },
  ],
}

const VERIFICATION: Verification = {
  country: 'UZ',
  cards: [
    {
      candidate_id: 'a',
      fields: [
        { field: 'act.effective_date', status: 'ok', comment: 'matches' },
        { field: 'act.number', status: 'mismatch', correct_value: '24/3', quote: '24/3', url: AMEND, comment: 'wrong' },
      ],
      verdict: 'needs_correction',
    },
  ],
  returned: [{ id: 'b', reason: 'Actually relevant' }],
  watched_acts_check: [
    { registration_number: '3254', new_edition_found: true, edition_date: '2026-07-20', url: AMEND },
    { registration_number: '3255', new_edition_found: false },
  ],
}

test('все схемы компилируются под strict', () => {
  for (const n of SCHEMA_NAMES) {
    assert.doesNotThrow(() => createValidator(n, dir), n)
    assert.equal((loadSchema(n, dir) as { type: string }).type, 'object')
    assert.doesNotMatch(schemaForCli(n, dir), /\n/)
  }
})

test('минимальные валидные примеры', () => {
  assert.deepEqual(v('triage')(TRIAGE), { ok: true })
  assert.deepEqual(v('verification')(VERIFICATION), { ok: true })
  assert.deepEqual(v('verify-sources')({
    country: 'UZ',
    sources: [{
      id: 's1', reachable: true, login_or_captcha: false, final_url: 'https://x', official: true, official_reason: 'gov',
      type_matches: true, has_dated_listing: true, needs_js: 'no', language: 'uz',
      profile: { kind: 'rss', url: 'https://x/rss' },
      seen_latest: [{ title: 't', date: '2026-01-01', url: 'https://x/1' }],
      verdict: 'ok', reasons: [],
    }, {
      id: 's2', reachable: false, login_or_captcha: false, final_url: '', official: false, official_reason: '',
      type_matches: false, has_dated_listing: false, needs_js: 'unknown', language: 'uz',
      profile: null, seen_latest: [], verdict: 'fail', reasons: ['down'],
    }],
    watched_acts: [{ registration_number: '3254', verdict: 'ok', reason: '' }],
  }), { ok: true })
  assert.deepEqual(v('discover-sources')({
    country: 'UZ',
    proposals: [{ type: 'regulator', name: 'CBU', url: 'https://cbu.uz', listing_url: 'https://cbu.uz/l', language: 'uz', reason: 'r' }],
    watched_act_proposals: [{
      act_type: 'banking_law', title_original: 't', number: 'unknown', url: 'https://lex.uz/docs/1',
      last_edition_date: '2026-01-01', quote: 'q', reason: 'r',
    }],
  }), { ok: true })
  assert.deepEqual(v('news-sweep')({
    country: 'UZ',
    leads: [{ headline: 'h', outlet: 'o', date: '2026-10-01', url: 'u', act_number: '1', act_date: '', issuer: 'i', summary: 's' }],
  }), { ok: true })
  assert.deepEqual(v('translation')({ items: [{ id: 't1', ru: 'Комитет по рискам' }] }), { ok: true })
  assert.deepEqual(v('translation')({ items: [] }), { ok: true })
})

test('translation: короткие фрагменты по id, без Markdown-полей', () => {
  const tr = v('translation')
  assert.equal(tr({ digest_ru: '# D', reports: [] }).ok, false)
  assert.equal(tr({}).ok, false)
  assert.equal(tr({ items: [{ id: 't1' }] }).ok, false)
  assert.equal(tr({ items: [{ id: 't1', ru: 'x', en: 'y' }] }).ok, false)
  assert.equal(tr({ items: [{ id: 't1', ru: 'x'.repeat(2001) }] }).ok, false)
  const ok: Translation = { items: [{ id: 't1', ru: 'x'.repeat(2000) }] }
  assert.equal(tr(ok).ok, true)
})

test('discover-sources: watched_act_proposals', () => {
  const val = v('discover-sources')
  const item = { act_type: 'aml_law', title_original: 't', number: '12', url: 'https://x', last_edition_date: 'unknown', quote: 'q', reason: 'r' }
  const base = { country: 'MN', proposals: [] as unknown[], watched_act_proposals: [item] as unknown[] }
  assert.deepEqual(val(base), { ok: true })
  assert.deepEqual(val({ ...base, watched_act_proposals: [] }), { ok: true })
  assert.equal(val({ country: 'MN', proposals: [] }).ok, false)
  assert.equal(val({ ...base, watched_act_proposals: [{ ...item, extra: 1 }] }).ok, false)
  assert.equal(val({ ...base, watched_act_proposals: [{ ...item, act_type: 'tax_law' }] }).ok, false)
  assert.equal(val({ ...base, watched_act_proposals: [{ ...item, last_edition_date: '01.01.2026' }] }).ok, false)
  assert.equal(val({ ...base, watched_act_proposals: [{ ...item, quote: 'x'.repeat(301) }] }).ok, false)
  assert.equal(val({ ...base, watched_act_proposals: [{ ...item, quote: 'x'.repeat(300) }] }).ok, true)
})

test('полная карточка по эталону UZ-3254-2 проходит', () => {
  assert.deepEqual(v('card')(FIXTURE_FORM_ONLY), { ok: true })
  assert.equal(FIXTURE_FORM_ONLY.changes.length, 10)
})

test('карточка: unknown-факты и update_of', () => {
  const c = clone(FIXTURE_FORM_ONLY)
  c.act.effective_date = { ...U }
  c.act.transition_period.exists = { ...U }
  c.change_count.annex_items = { ...U }
  c.update_of = { ledger_key: 'reg:3254-1', what_changed: 'Registered' }
  assert.deepEqual(v('card')(c), { ok: true })
})

test('карточка: отказы', () => {
  const card = v('card')
  const bad = (mut: (c: Card) => void): string => {
    const c = clone(FIXTURE_FORM_ONLY)
    mut(c)
    const r = card(c)
    assert.equal(r.ok, false)
    return r.ok ? '' : r.error
  }
  assert.match(bad((c) => { (c as unknown as Record<string, unknown>).extra = 1 }), /unexpected property "extra"/)
  assert.match(bad((c) => { delete (c.act.number as Partial<Card['act']['number']>).quote }), /quote/)
  bad((c) => { c.act.number.quote = 'x'.repeat(301) })
  assert.equal(card((() => { const c = clone(FIXTURE_FORM_ONLY); c.act.number.quote = 'x'.repeat(300); return c })()).ok, true)
  assert.match(bad((c) => { (c.changes[0] as { significance: string }).significance = 'huge' }), /significance/)
  bad((c) => { c.act.adoption_date.value = '17.09.2026' })
  bad((c) => { (c.change_count.annex_items as { value: unknown }).value = 10.5 })
  bad((c) => { (c.act.transition_period.exists as { value: unknown }).value = 'maybe' })
  bad((c) => { (c as { stage: string }).stage = 'done' })
})

test('triage: отказы', () => {
  const triage = v('triage')
  const t = clone(TRIAGE)
  t.items[1]!.reason_code = null
  const r = triage(t)
  assert.equal(r.ok, false)
  const t2 = clone(TRIAGE)
  t2.items[0]!.reason_text = 'x'.repeat(201)
  assert.equal(triage(t2).ok, false)
  const t3 = clone(TRIAGE) as unknown as { items: Array<Record<string, unknown>> }
  t3.items[0]!.reason_code = 'made_up'
  assert.equal(triage(t3).ok, false)
  // relevant/borderline с кодом допустимы
  const t4 = clone(TRIAGE)
  t4.items[0]!.decision = 'borderline'
  t4.items[0]!.reason_code = 'not_regulatory'
  assert.equal(triage(t4).ok, true)
})

test('verification: отказы', () => {
  const ver = v('verification')
  const a = clone(VERIFICATION)
  a.cards[0]!.verdict = 'maybe' as never
  assert.equal(ver(a).ok, false)
  const b = clone(VERIFICATION)
  b.watched_acts_check[0]!.edition_date = '20.07.2026'
  assert.equal(ver(b).ok, false)
  const c = clone(VERIFICATION) as unknown as { returned: Array<Record<string, unknown>> }
  delete c.returned[0]!.reason
  assert.equal(ver(c).ok, false)
})

test('error короткий и читаемый', () => {
  const r = v('card')({ bogus: 1 })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.ok(r.error.length <= 800)
    assert.match(r.error, /candidate_id/)
  }
})
