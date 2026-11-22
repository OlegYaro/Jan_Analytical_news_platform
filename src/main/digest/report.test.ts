// Подробный отчёт страны (ARC-04) на реальных карточках 24/2 и 22/4 (fixtures, см. build.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildCountryReport } from './report.ts'
import { extractFacts } from '../checks/numbers.ts'
import type { DigestCountry } from './build.ts'
import type { Card } from '../../shared/schema-types.ts'
import type { CountryResult, ResultItem } from '../../shared/pipeline-types.ts'

const load = (n: string): Card => JSON.parse(readFileSync(new URL(`./fixtures/${n}.card.json`, import.meta.url), 'utf8')) as Card
const c24 = load('uz-24-2')
const c22 = load('uz-22-4')

function item(card: Card, extra: Partial<ResultItem> = {}): ResultItem {
  return {
    candidate_id: card.candidate_id, key: `reg:${card.candidate_id}`, channel: 'B', kind: 'new', confirmed: true,
    disputed_fields: [], rounds: 1, title_en: card.act.title_en, card_file: `acts/${card.candidate_id}/card.json`, ...extra,
  }
}

function country(over: Partial<CountryResult> = {}, cards: Record<string, Card> = { [c24.candidate_id]: c24, [c22.candidate_id]: c22 }): DigestCountry {
  return {
    code: 'UZ', nameRu: 'Узбекистан', flag: '🇺🇿',
    result: {
      country: 'UZ', status: 'changes' as CountryResult['status'], items: [item(c24), item(c22)], duplicates: [], warnings: [], to_commit: [],
      for_information: [{ candidate_id: 'x1', key: 'k', title_original: 'Hisoblar', issuer: 'ЦБ', date: '2026-10-01', url: 'https://lex.uz/docs/1', reason: 'Minor change to account forms.', points: ['Point 3: new form'] }],
      unverified: [{ candidate_id: 'x2', title_original: 'PDF-акт 3976', issuer: 'Президент', date: '2026-11-01', url: 'https://lex.uz/pdfs/3976', reason: 'текста акта на сайте нет (возможно, только PDF-скан)' }],
      ...over,
    },
    cards,
  }
}

test('report.en.md: заголовок, сводка, обе карточки целиком', () => {
  const md = buildCountryReport(country(), 'en')
  assert.match(md, /^# RegWatch — 🇺🇿 Uzbekistan \(UZ\): detailed report\n/)
  assert.match(md, /\*\*Summary:\*\* material: 2 · for information: 1 · could not be verified: 1/)
  assert.match(md, /## 1\. On amendments and additions to the Regulation on Corporate Governance in Commercial Banks/)
  assert.match(md, /## 2\. On approval of the Regulation on the procedure for retail payments through the payment switch/)
  // реквизиты с цитатами и ссылками
  assert.match(md, /- \*\*Number:\*\* 24\/2 — “2026 yil 17 sentabr, 24\/2-son” — <https:\/\/lex\.uz\/docs\/8530799>/)
  assert.match(md, /- \*\*MoJ registration number:\*\* 3254-2 — “roʻyxat raqami 3254-2”/)
  assert.match(md, /- \*\*Effective:\*\* 2027-01-13 — /)
  assert.match(md, /- \*\*Transition period:\*\* no — /)
  assert.match(md, /- \*\*Official Russian text:\*\* unknown/)
  // изменяемый акт и прежние изменения; у 22/4 — новый акт
  assert.match(md, /- \*\*Registration number:\*\* 3254 — “roʻyxat raqami 3254”/)
  assert.match(md, /  - 3254-1 \(CB Board resolution 19\/8 of 08\.07\.2026, amending the preamble\) — 18\.07\.2026/)
  assert.match(md, /New act \(does not amend another act\)\./)
  // все изменения: значимость, сложность, цитата, источник
  assert.match(md, /### Changes \(8\) — 🔴 3 · 🟠 4 · ⚪ 1/)
  assert.match(md, /### Changes \(5\) — 🔴 1 · 🟠 3 · ⚪ 1/)
  for (const c of [...c24.changes, ...c22.changes]) {
    assert.ok(md.includes(`#### ${c.n}. ${c.location.replace(/\s+/g, ' ')} — `), c.location)
    assert.ok(md.includes(c.summary_en.replace(/\s+/g, ' ').trim()), `summary ${c.n}`)
    assert.ok(md.includes(`“${c.quote.replace(/\s+/g, ' ').trim()}”`), `quote ${c.n}`)
  }
  assert.match(md, /- \*\*Significance:\*\* 🔴 significant — Constrains board committee composition/)
  assert.match(md, /- \*\*Implementation difficulty:\*\* high — /)
  // ссылки, unknown-поля, заметки
  assert.match(md, /- Version on the effective date: <https:\/\/www\.lex\.uz\/docs\/-4888804\?ONDATE=13\.01\.2027>/)
  assert.match(md, /### Fields that could not be established\n\n- `not_applies_to`\n- `change_count\.legal_base_marks`/)
  assert.match(md, /### Notes\n\nThe act is registered and published/)
  // для сведения и не удалось проверить
  assert.match(md, /## For information\n\n- \*\*Hisoblar\*\* — ЦБ, 01\.10\.2026 — <https:\/\/lex\.uz\/docs\/1>\n  - Minor change to account forms\.\n  - Points: Point 3: new form/)
  assert.match(md, /## ⚠ Could not be verified\n\n- \*\*PDF-акт 3976\*\* — Президент, 01\.11\.2026 — <https:\/\/lex\.uz\/pdfs\/3976>\n  - Reason: the site has no act text \(possibly only a PDF scan\)/)
  assert.match(md, /Not legal advice\./)
})

test('отчёт не теряет ни одного номера и URL карточки (полнота второго уровня)', () => {
  for (const card of [c24, c22]) {
    const md = buildCountryReport(country({ items: [item(card)], for_information: [], unverified: [] }, { [card.candidate_id]: card }), 'en')
    const got = extractFacts(md)
    const act = card.act
    const src = [act.number.value, act.registration_number.value, card.amends.base_act_number.value, ...Object.values(card.links), ...card.changes.map((c) => c.url)].join(' ')
    const want = extractFacts(src)
    for (const n of want.actNumbers) assert.ok(got.actNumbers.includes(n), `${card.candidate_id}: номер ${n}`)
    for (const u of want.urls) assert.ok(got.urls.includes(u), `${card.candidate_id}: ссылка ${u}`)
    for (const d of [act.adoption_date, act.registration_date, act.publication_date, act.effective_date]) assert.ok(md.includes(String(d.value)), `${card.candidate_id}: дата ${d.value}`)
  }
})

test('неподтверждённые поля, обновление, нет карточки, пустая страна', () => {
  const md = buildCountryReport(
    country({ items: [item(c24, { confirmed: false, disputed_fields: ['act.effective_date'], kind: 'update', first_reported_at: '2026-10-20', update_reason: 'stage' }), item(c22, { candidate_id: 'gone', title_en: 'Lost card' })] }),
    'en',
  )
  assert.match(md, /🔄 Update, first reported 20\.10\.2026 \(stage\)/)
  assert.match(md, /⚠ unconfirmed: fields act\.effective_date/)
  assert.match(md, /## 2\. Lost card\n\nAct card unavailable\./)
  const empty = buildCountryReport(country({ items: [], for_information: [], unverified: [] }, {}), 'en')
  assert.match(empty, /No findings\./)
  assert.doesNotMatch(empty, /## For information/)
})

test('ru: подписи по-русски, содержание исходное английское', () => {
  const md = buildCountryReport(country(), 'ru')
  assert.match(md, /^# RegWatch — 🇺🇿 Узбекистан \(UZ\): подробный отчёт/)
  assert.match(md, /### Изменения \(8\) — 🔴 3 · 🟠 4 · ⚪ 1/)
  assert.match(md, /- \*\*Значимость:\*\* 🔴 значимое — Constrains board committee composition/)
  assert.match(md, /- Причина: текста акта на сайте нет/)
  assert.match(md, /Не является юридической консультацией/)
})

test('ссылки не http(s) не становятся кликабельными', () => {
  const bad: Card = JSON.parse(JSON.stringify(c24))
  bad.links.current_version = 'javascript:alert(1)'
  const md = buildCountryReport(country({ items: [item(bad)], for_information: [], unverified: [] }, { [bad.candidate_id]: bad }), 'en')
  assert.match(md, /- Current version: `javascript:alert\(1\)`/)
  assert.doesNotMatch(md, /<javascript:/)
})
