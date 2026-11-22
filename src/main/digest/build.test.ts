// Тесты сборки письма. Фикстуры — реальные карточки прогона ~/RegWatch/runs/2026-11-18_1517/UZ/acts/
// lexuz-8530799/card.json (24/2, эталон) и lexuz-8554315/card.json (22/4), скопированы целиком.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildDigest, collectTranslatable, headlineRu, requisites, type DigestInput } from './build.ts'
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

function result(over: Partial<CountryResult>): CountryResult {
  return { country: 'UZ', status: 'ok' as CountryResult['status'], items: [], duplicates: [], warnings: [], to_commit: [], ...over }
}

function input(over: Partial<DigestInput> = {}): DigestInput {
  return {
    runId: '2026-11-18_1517', date: '2026-11-18',
    countries: [{
      code: 'UZ', nameRu: 'Узбекистан', flag: '🇺🇿',
      result: result({
        items: [item(c24), item(c22)],
        for_information: [{ candidate_id: 'x1', key: 'k', title_original: 'Hisoblar', issuer: 'ЦБ', date: '2026-10-01', url: 'https://lex.uz/docs/1', reason: 'minor', points: [] }],
        unverified: [{ candidate_id: 'x2', title_original: 'PDF-акт 3976', issuer: 'Президент', date: '2026-11-01', url: 'https://lex.uz/pdfs/3976', reason: 'текста акта нет' }],
      }),
      cards: { [c24.candidate_id]: c24, [c22.candidate_id]: c22 },
    }],
    checked: { ok: 9, total: 9 }, failures: [], ...over,
  }
}

test('эталон 24/2: реквизиты, вступление, три 🔴, три ссылки', () => {
  const d = buildDigest(input())
  assert.equal(d.hasContent, true)
  assert.match(d.text, /№ 24\/2 от 17\.09\.2026/)
  assert.match(d.text, /рег\. МЮ № 3254-2 от 09\.10\.2026/)
  assert.match(d.text, /Вступает 13\.01\.2027, переходного периода нет/)
  assert.match(d.text, /Изменяет Положение рег\. № 3254\. Изменений: 10 — 🔴 3 · 🟠 4 · ⚪ 1/)
  const block = d.text.split('\n').filter((l) => l.startsWith('🔴'))
  assert.equal(block.filter((l) => /Audit committee/.test(l) || /п\. (16|19|8)/.test(l)).length, 3)
  assert.match(d.text, /Читать: изменения https:\/\/lex\.uz\/docs\/8530799 · действующая редакция https:\/\/www\.lex\.uz\/docs\/-4888804 · новая редакция https:\/\/www\.lex\.uz\/docs\/-4888804\?ONDATE=13\.01\.2027/)
  assert.match(d.text, /Корпоративное управление в банках/)
})

test('сводка страны и тема письма', () => {
  const d = buildDigest(input())
  assert.match(d.text, /🇺🇿 Узбекистан — 2 существенных, 1 для сведения, 1 не удалось проверить/)
  assert.equal(d.subject, 'RegWatch: UZ — 2 существенных, 1 для сведения, 1 не удалось проверить')
})

test('тема с несколькими странами', () => {
  const kz = { code: 'KZ', nameRu: 'Казахстан', result: result({ country: 'KZ', for_information: input().countries[0]!.result.for_information }), cards: {} }
  const uz = { ...input().countries[0]!, result: result({ items: [item(c24)] }), cards: { [c24.candidate_id]: c24 } }
  assert.equal(buildDigest(input({ countries: [uz, kz] })).subject, 'RegWatch: UZ — 1 существенный, KZ — 1 для сведения')
})

test('нет находок — письмо не нужно (DLV-01); страны без находок не расписываются', () => {
  const empty = { code: 'KZ', nameRu: 'Казахстан', result: result({ country: 'KZ' }), cards: {} }
  const d = buildDigest(input({ countries: [empty] }))
  assert.equal(d.hasContent, false)
  const d2 = buildDigest(input({ countries: [empty, input().countries[0]!] }))
  assert.equal(d2.hasContent, true)
  assert.doesNotMatch(d2.text, /Казахстан —/)
})

test('запасной вариант без headline/top_changes: тема по title_en, 🔴 из changes; сложный — пометка', () => {
  assert.equal(c22.headline, undefined)
  assert.equal(headlineRu(c22), 'Платёжный коммутатор')
  const d = buildDigest(input())
  assert.match(d.text, /🔴 п\. 2 прил\. — .*\(внедрить сложно\)/)
  assert.match(d.text, /Новый акт\.\n/)
  const other = { ...c24, headline: 'Fee caps', top_changes: undefined, act: { ...c24.act, title_en: 'Zzz' } }
  assert.equal(headlineRu(other as Card), 'Fee caps')
})

test('top_changes ограничены тремя; headline из карточки используется', () => {
  const tc = [1, 2, 3, 4, 5].map((n) => ({ n, location: `п. ${n}`, summary_en: `s${n}`, implementation_difficulty: 'low' as const }))
  const card = { ...c24, top_changes: tc }
  const d = buildDigest(input({ countries: [{ code: 'UZ', nameRu: 'Узбекистан', result: result({ items: [item(card)] }), cards: { [card.candidate_id]: card } }] }))
  assert.equal(d.text.split('\n').filter((l) => l.startsWith('🔴')).length, 3)
  assert.match(d.text, /🔴 п\. 3 — s3/)
})

test('unknown не скрывается (HAL-08)', () => {
  const card: Card = JSON.parse(JSON.stringify(c24))
  card.act.number.value = 'unknown'
  card.act.registration_number.value = 'unknown'
  card.act.effective_date.value = 'unknown'
  assert.match(requisites(card), /№ не удалось установить/)
  assert.match(requisites(card), /рег\. МЮ № не удалось установить/)
  const d = buildDigest(input({ countries: [{ code: 'UZ', nameRu: 'Узбекистан', result: result({ items: [item(card)] }), cards: { [card.candidate_id]: card } }] }))
  assert.match(d.text, /Дата вступления: не удалось установить/)
})

test('не подтверждено и обновление помечаются', () => {
  const it = item(c24, { confirmed: false, disputed_fields: ['act.effective_date', 'changes[2].location'], kind: 'update', first_reported_at: '2026-10-20' })
  const d = buildDigest(input({ countries: [{ code: 'UZ', nameRu: 'Узбекистан', result: result({ items: [it] }), cards: { [c24.candidate_id]: c24 } }] }))
  assert.match(d.text, /⚠ не подтверждено: поля act\.effective_date, changes\[2\]\.location/)
  assert.match(d.text, /🔄 Обновление, впервые сообщали 20\.10\.2026/)
})

test('подвал: проверено N из N, сбои, оговорки', () => {
  const d = buildDigest(input({ checked: { ok: 8, total: 9 }, failures: [{ code: 'KG', nameRu: 'Киргизия', reason: 'сайт не отвечает' }] }))
  assert.match(d.text, /Проверено 8 из 9 стран/)
  assert.match(d.text, /Киргизия \(сайт не отвечает\)/)
  assert.match(d.text, /Не является юридической консультацией/)
  assert.match(d.text, /перевод неофициальный/)
})

test('HTML: экранирование, кликабельные ссылки, ширина 640, опасные ссылки не href', () => {
  const evil = { candidate_id: 'e', key: 'k', title_original: '<script>alert(1)</script> & "x"', issuer: 'I', date: '2026-10-01', url: 'javascript:alert(1)', reason: 'r', points: [] }
  const ok = { ...evil, candidate_id: 'o', title_original: 'ok', url: 'https://lex.uz/a?b=1&c=2' }
  const d = buildDigest(input({ countries: [{ code: 'UZ', nameRu: 'Узб<>', result: result({ for_information: [evil, ok] }), cards: {} }] }))
  assert.doesNotMatch(d.html, /<script>/)
  assert.match(d.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;x&quot;/)
  assert.doesNotMatch(d.html, /href="javascript/)
  assert.match(d.html, /<a href="https:\/\/lex\.uz\/a\?b=1&amp;c=2"/)
  assert.match(d.html, /max-width:640px/)
  assert.match(d.html, /Узб&lt;&gt;/)
})

// ---------- язык письма и перевод (фаза 7, CFG-08, LNG-02/03) ----------

const SNAPSHOT_RU = readFileSync(new URL('./fixtures/uz-digest.ru.txt', import.meta.url), 'utf8')

test('неизменность старого вывода: по умолчанию, lang ru и перевод «как есть» дают тот же текст', () => {
  // Снимок — вывод прежней сборки на тех же фикстурах; единственное отличие — тема в строке «Для сведения» (minor).
  const base = buildDigest(input())
  assert.equal(base.text, SNAPSHOT_RU)
  assert.equal(buildDigest(input(), { lang: 'ru' }).text, SNAPSHOT_RU)
  assert.equal(buildDigest(input(), { lang: 'ru', translate: (s) => s }).text, SNAPSHOT_RU)
  assert.equal(buildDigest(input(), { lang: 'ru', translate: () => '' }).text, SNAPSHOT_RU)
  assert.equal(buildDigest(input(), { lang: 'ru', translate: (s) => s }).html, base.html)
  assert.match(base.html, /<html lang="ru">/)
})

test('en: служебные подписи, страна и тема по-английски, без «перевод неофициальный»', () => {
  const d = buildDigest(input({ failures: [{ code: 'KG', nameRu: 'Киргизия', reason: 'Сайт не отвечает за 30 секунд' }], checked: { ok: 8, total: 9 } }), { lang: 'en' })
  assert.equal(d.subject, 'RegWatch: UZ — 2 material, 1 for information, 1 could not be verified')
  assert.match(d.text, /^RegWatch — digest 18\.11\.2026\n/)
  assert.match(d.text, /🇺🇿 Uzbekistan — 2 material, 1 for information, 1 could not be verified/)
  assert.match(d.text, /CB Board resolution No\. 24\/2 of 17\.09\.2026, MoJ reg\. No\. 3254-2 of 09\.10\.2026/)
  assert.match(d.text, /Effective 13\.01\.2027, no transition period/)
  assert.match(d.text, /Amends Regulation reg\. No\. 3254\. Changes: 10 — 🔴 3 · 🟠 4 · ⚪ 1/)
  assert.match(d.text, /🔴 Annex item 7 \(para 16\) — Audit committee/)
  assert.match(d.text, /\(hard to implement\)/)
  assert.match(d.text, /Read: amending act https:\/\/lex\.uz\/docs\/8530799 · current version https:\/\/www\.lex\.uz\/docs\/-4888804 · new version https:\/\/www\.lex\.uz\/docs\/-4888804\?ONDATE=13\.01\.2027/)
  assert.match(d.text, /\nFor information\n· minor — Hisoblar — ЦБ, 01\.10\.2026 — https:\/\/lex\.uz\/docs\/1/)
  assert.match(d.text, /\n⚠ Could not be verified\n/)
  assert.match(d.text, /Checked 8 of 9 countries · failed: Kyrgyzstan \(The site did not respond within 30 seconds\) · Not legal advice · Details in the attachment/)
  // Русских служебных подписей нет (кириллица только в данных сайта: «ЦБ», «PDF-акт», «Президент»).
  assert.doesNotMatch(d.text, /Вступает|Проверено|Читать|сведения|неофициальный|Узбекистан|Изменений|существенн/)
  assert.match(d.html, /<html lang="en">/)
  assert.equal(buildDigest(input({ countries: [] }), { lang: 'en' }).subject, 'RegWatch: no changes')
})

test('en: тема с несколькими странами; nameEn важнее встроенного списка', () => {
  const kz = { code: 'KZ', nameRu: 'Казахстан', result: result({ country: 'KZ', for_information: input().countries[0]!.result.for_information }), cards: {} }
  const uz = { ...input().countries[0]!, nameEn: 'Republic of Uzbekistan', result: result({ items: [item(c24), item(c22)] }) }
  const d = buildDigest(input({ countries: [uz, kz] }), { lang: 'en' })
  assert.equal(d.subject, 'RegWatch: UZ — 2 material, KZ — 1 for information')
  assert.match(d.text, /🇺🇿 Republic of Uzbekistan — 2 material/)
  assert.match(d.text, /\nKazakhstan — 1 for information/)
})

test('ru с переводом: строки 🔴 и «для сведения» по-русски; оригинальное название и ссылка сохраняются', () => {
  const info = [{ candidate_id: 'x1', key: 'k', title_original: 'Hisob raqamlari toʻgʻrisida', issuer: 'ЦБ', date: '2026-10-01', url: 'https://lex.uz/docs/1', reason: 'Minor change to account opening forms.', points: ['Point 3: new form'] }]
  const inp = input({ countries: [{ ...input().countries[0]!, result: result({ items: [item(c24)], for_information: info }) }] })
  const dict: Record<string, string> = {
    'Risk committee is mandatory for systemically important banks (optional for others). If set up, a majority of members must not be related persons and the chair must be an independent board member other than the board chair.':
      'Комитет по рискам обязателен для системно значимых банков (для остальных — по желанию).',
    'Minor change to account opening forms.': 'Мелкая правка форм открытия счетов.',
  }
  const d = buildDigest(inp, { lang: 'ru', translate: (s) => dict[s] ?? s })
  assert.match(d.text, /🔴 п\. 19 — Комитет по рискам обязателен/)
  // Без перевода фрагмент остаётся английским.
  assert.match(d.text, /🔴 п\. 16 — Audit committee/)
  assert.match(d.text, /· Мелкая правка форм открытия счетов — Hisob raqamlari toʻgʻrisida — ЦБ, 01\.10\.2026 — https:\/\/lex\.uz\/docs\/1/)
  assert.match(d.text, /Корпоративное управление в банках/)
})

test('collectTranslatable: уникальные английские фрагменты в порядке письма; русское и словарное — не просит', () => {
  const kz = { code: 'KZ', nameRu: 'Казахстан', result: result({ country: 'KZ', items: [item(c24)] }), cards: { [c24.candidate_id]: c24 } }
  const other = { ...c24, candidate_id: 'z', headline: 'Fee caps for card payments' }
  const uz = {
    ...input().countries[0]!,
    result: result({
      items: [item(c24), item(other as Card)],
      for_information: [{ candidate_id: 'x1', key: 'k', title_original: 'T', issuer: 'I', date: '', url: 'https://x', reason: '', points: ['Point 2: deposit forms'] }],
      unverified: [{ candidate_id: 'x2', title_original: 'U', issuer: 'I', date: '', url: 'https://y', reason: 'страница акта не открылась' }],
    }),
    cards: { [c24.candidate_id]: c24, z: other as Card },
  }
  const list = collectTranslatable(input({ countries: [uz, kz] }))
  const tops = c24.changes.filter((c) => c.significance === 'significant').map((c) => c.summary_en)
  assert.deepEqual(list, [...tops, 'Fee caps for card payments', 'Point 2: deposit forms'])
  assert.equal(new Set(list).size, list.length)
  assert.ok(!list.some((s) => /[А-Яа-я]/.test(s)))
  // Ровно то, что спрашивает сборка.
  const asked: string[] = []
  buildDigest(input({ countries: [uz, kz] }), { lang: 'ru', translate: (s) => (asked.push(s), s) })
  assert.deepEqual([...new Set(asked)], list)
  // Английскому письму перевод не нужен.
  const none: string[] = []
  buildDigest(input({ countries: [uz] }), { lang: 'en', translate: (s) => (none.push(s), s) })
  assert.deepEqual(none, [])
})

test('T-7: перевод с подменённым числом отвергнут — в письме остаётся английский', async () => {
  const { compareNumbers } = await import('../checks/numbers.ts')
  const en = collectTranslatable(input())
  // Как createTranslator: перевод попадает в словарь только после сверки чисел.
  const bad: Record<string, string> = {}
  for (const s of en) bad[s] = s.includes('P2P') ? 'Запросы авторизации по 3 видам платежей направляются через коммутатор ЦБ.' : s
  const translations: Record<string, string> = {}
  for (const [k, v] of Object.entries(bad)) if (compareNumbers(k, v).ok) translations[k] = v
  const p2p = en.find((s) => s.includes('P2P'))!
  assert.equal(compareNumbers(p2p, bad[p2p]!).ok, false)
  assert.equal(translations[p2p], undefined)
  const d = buildDigest(input(), { lang: 'ru', translate: (s) => translations[s] ?? s })
  assert.match(d.text, /🔴 п\. 2 прил\. — Authorization requests and payment messages/)
  assert.doesNotMatch(d.text, /3 видам/)
})
