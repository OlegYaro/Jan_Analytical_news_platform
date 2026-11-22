// Сборка письма-дайджеста кодом из карточек (DLV-01..04, docs/05 §8). Чистая логика: ни сети, ни модели.
// Модель письмо только переводит (если выбран русский): короткие английские фрагменты (тема акта, строки 🔴,
// «для сведения») приходят переведёнными через opts.translate; структура, числа и ссылки — здесь.
// Язык письма (CFG-08): 'ru' (по умолчанию) — подписи по-русски, английские фрагменты через translate;
// 'en' — всё по-английски, перевод не нужен.

import type { Card } from '../../shared/schema-types.ts'
import type { CountryResult, ForInfoItem, ResultItem, UnverifiedItem } from '../../shared/pipeline-types.ts'
import { translateMsg } from '../runner/messages-en.ts'
import type { DigestLang } from './contracts.ts'

export interface DigestCountry {
  code: string
  nameRu: string
  /** Название по-английски (для письма на английском); запасной вариант — встроенный список, затем nameRu. */
  nameEn?: string
  flag?: string
  result: CountryResult
  cards: Record<string, Card>
}

export interface DigestInput {
  runId: string
  /** Дата прогона (ISO или ДД.ММ.ГГГГ) — для заголовка письма. */
  date: string
  countries: DigestCountry[]
  checked: { ok: number; total: number }
  failures: Array<{ code: string; nameRu: string; nameEn?: string; reason: string }>
}

export interface DigestOutput {
  subject: string
  html: string
  text: string
  hasContent: boolean
}

export interface DigestOptions {
  /** Язык письма; по умолчанию 'ru'. */
  lang?: DigestLang
  /**
   * Только для 'ru': перевод английского фрагмента (результат createTranslator, уже сверенный по числам).
   * Вернул тот же текст (нет перевода или он отвергнут) — в письме остаётся английский.
   */
  translate?: (s: string) => string
}

// ---------- строки с гиперссылками ----------

type Part = string | { t: string; href: string }
type Style = 'country' | 'title' | 'body' | 'bullet' | 'heading' | 'muted' | 'warn'
interface Line {
  parts: Part[]
  style: Style
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Ссылки пускаем в href только http(s): остальное (javascript: и т. п.) выводится текстом. */
export function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : null
}

// ---------- подписи на двух языках ----------

function plural(n: number, one: string, few: string, many: string): string {
  const a = n % 100
  const b = n % 10
  if (a >= 11 && a <= 14) return many
  if (b === 1) return one
  if (b >= 2 && b <= 4) return few
  return many
}

interface Labels {
  notFound: string
  heading: (date: string) => string
  material: (n: number) => string
  forInfo: (n: number) => string
  unverified: (n: number) => string
  noChanges: string
  noCard: string
  update: (date: string) => string
  unconfirmed: (fields: string[]) => string
  act: string
  no: string
  of: string
  reg: string
  effective: (date: string) => string
  effectiveUnknown: string
  tpYes: string
  tpNo: string
  tpUnknown: string
  amends: (n: string) => string
  newAct: string
  changes: (total: number) => string
  hard: string
  read: string
  linkAmending: string
  linkCurrent: string
  linkNew: string
  forInfoHeading: string
  unverifiedHeading: string
  checked: (ok: number, total: number) => string
  failed: string
  disclaimer: string
  unofficial: string
  details: string
}

const RU: Labels = {
  notFound: 'не удалось установить',
  heading: (d) => `RegWatch — дайджест ${d}`,
  material: (n) => `${n} ${plural(n, 'существенный', 'существенных', 'существенных')}`,
  forInfo: (n) => `${n} для сведения`,
  unverified: (n) => `${n} не удалось проверить`,
  noChanges: 'RegWatch: изменений нет',
  noCard: 'Карточка акта недоступна — подробности в приложении.',
  update: (d) => `🔄 Обновление, впервые сообщали ${d}`,
  unconfirmed: (f) => `⚠ не подтверждено${f.length > 0 ? `: поля ${f.join(', ')}` : ''}`,
  act: 'Акт',
  no: '№',
  of: 'от',
  reg: 'рег. МЮ №',
  effective: (d) => `Вступает ${d}`,
  effectiveUnknown: 'Дата вступления: не удалось установить',
  tpYes: 'есть переходный период',
  tpNo: 'переходного периода нет',
  tpUnknown: 'переходный период: не удалось установить',
  amends: (n) => `Изменяет Положение рег. № ${n}.`,
  newAct: 'Новый акт.',
  changes: (t) => `Изменений: ${t}`,
  hard: ' (внедрить сложно)',
  read: 'Читать: ',
  linkAmending: 'изменения',
  linkCurrent: 'действующая редакция',
  linkNew: 'новая редакция',
  forInfoHeading: 'Для сведения',
  unverifiedHeading: '⚠ Не удалось проверить',
  checked: (ok, total) => `Проверено ${ok} из ${total} стран`,
  failed: 'со сбоем: ',
  disclaimer: 'Не является юридической консультацией',
  unofficial: 'официального русского текста нет — перевод неофициальный',
  details: 'Подробно в приложении',
}

const EN: Labels = {
  notFound: 'unknown',
  heading: (d) => `RegWatch — digest ${d}`,
  material: (n) => `${n} material`,
  forInfo: (n) => `${n} for information`,
  unverified: (n) => `${n} could not be verified`,
  noChanges: 'RegWatch: no changes',
  noCard: 'Act card unavailable — details in the attachment.',
  update: (d) => `🔄 Update, first reported ${d}`,
  unconfirmed: (f) => `⚠ unconfirmed${f.length > 0 ? `: fields ${f.join(', ')}` : ''}`,
  act: 'Act',
  no: 'No.',
  of: 'of',
  reg: 'MoJ reg. No.',
  effective: (d) => `Effective ${d}`,
  effectiveUnknown: 'Effective date: unknown',
  tpYes: 'with a transition period',
  tpNo: 'no transition period',
  tpUnknown: 'transition period: unknown',
  amends: (n) => `Amends Regulation reg. No. ${n}.`,
  newAct: 'New act.',
  changes: (t) => `Changes: ${t}`,
  hard: ' (hard to implement)',
  read: 'Read: ',
  linkAmending: 'amending act',
  linkCurrent: 'current version',
  linkNew: 'new version',
  forInfoHeading: 'For information',
  unverifiedHeading: '⚠ Could not be verified',
  checked: (ok, total) => `Checked ${ok} of ${total} countries`,
  failed: 'failed: ',
  disclaimer: 'Not legal advice',
  unofficial: '',
  details: 'Details in the attachment',
}

/** Английские названия стартовых стран — на случай, если nameEn не передан. */
const COUNTRY_EN: Record<string, string> = {
  UZ: 'Uzbekistan', KZ: 'Kazakhstan', KG: 'Kyrgyzstan', TJ: 'Tajikistan', TM: 'Turkmenistan',
  GE: 'Georgia', AM: 'Armenia', AZ: 'Azerbaijan', MN: 'Mongolia',
}

/** Контекст сборки: язык, подписи и перевод фрагментов. */
interface Ctx {
  lang: DigestLang
  L: Labels
  /** Английский фрагмент → текст для письма (ru: перевод, если есть; en: как есть). */
  tr: (s: string) => string
}

/** Похоже на английский текст: есть латиница и нет кириллицы (русские сообщения кода не переводятся). */
function isEnglish(s: string): boolean {
  return /[A-Za-z]{2}/.test(s) && !/[А-Яа-яЁё]/.test(s)
}

function makeCtx(opts: DigestOptions | undefined): Ctx {
  const lang: DigestLang = opts?.lang ?? 'ru'
  const translate = opts?.translate
  const tr = (s: string): string => {
    if (lang !== 'ru' || !translate || !isEnglish(s)) return s
    const out = translate(s)
    return typeof out === 'string' && out.trim() !== '' ? out : s
  }
  return { lang, L: lang === 'en' ? EN : RU, tr }
}

function countryName(c: { code: string; nameRu: string; nameEn?: string }, lang: DigestLang): string {
  return lang === 'en' ? (c.nameEn ?? COUNTRY_EN[c.code] ?? c.nameRu) : c.nameRu
}

// ---------- форматирование ----------

function fmtDate(iso: string | undefined, L: Labels): string {
  if (!iso) return L.notFound
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso
}

function factValue(f: { value: string } | undefined): string | null {
  if (!f || f.value === 'unknown' || f.value.trim() === '') return null
  return f.value
}

/** Вид акта по-русски; неизвестное → null (английское значение карточки уйдёт на перевод). */
function actTypeRu(type: string): string | null {
  const t = type.toLowerCase()
  if (/board of the central bank|central bank.*board|board.*central bank/.test(t)) return 'Пост. Правления ЦБ'
  if (/president/.test(t) && /decree/.test(t)) return 'Указ Президента'
  if (/president/.test(t)) return 'Пост. Президента'
  if (/cabinet|council of ministers|government/.test(t)) return 'Пост. Кабмина'
  if (/^law\b|\blaw\b/.test(t)) return 'Закон'
  if (/\border\b/.test(t)) return 'Приказ'
  if (/\bresolution\b/.test(t)) return 'Постановление'
  return null
}

/** Вид акта коротко по-английски; неизвестное — как в карточке. */
function actTypeEn(type: string): string {
  const t = type.toLowerCase()
  if (/board of the central bank|central bank.*board|board.*central bank/.test(t)) return 'CB Board resolution'
  if (/president/.test(t) && /decree/.test(t)) return 'Presidential decree'
  if (/president/.test(t)) return 'Presidential resolution'
  if (/cabinet|council of ministers|government/.test(t)) return 'Cabinet resolution'
  if (/^law\b|\blaw\b/.test(t)) return 'Law'
  if (/\border\b/.test(t)) return 'Order'
  if (/\bresolution\b/.test(t)) return 'Resolution'
  return type
}

/** Простые соответствия для частых тем; запасной вариант — английская тема как есть. */
const HEADLINE_RU: Array<[RegExp, string]> = [
  [/corporate governance/i, 'Корпоративное управление в банках'],
  [/payment switch|retail payments/i, 'Платёжный коммутатор'],
  [/capital adequacy|capital requirement/i, 'Достаточность капитала банков'],
  [/liquidity/i, 'Ликвидность банков'],
  [/anti-money laundering|money laundering|aml\b/i, 'Противодействие отмыванию денег'],
  [/bank resolution|financial recovery|rehabilitation/i, 'Оздоровление банков'],
  [/deposit insurance|deposit guarantee/i, 'Страхование вкладов'],
  [/licens/i, 'Лицензирование'],
  [/sandbox/i, 'Регуляторная песочница'],
  [/disclosure/i, 'Раскрытие информации'],
  [/dividend/i, 'Дивиденды'],
  [/shareholder|ownership|significant participation/i, 'Акционеры и владение долями'],
  [/credit risk|loan|lending|credit/i, 'Кредитование'],
]

/** Английская тема акта: headline карточки, иначе title_en. */
export function headlineEn(card: Card): string {
  return ((card.headline ?? '').trim() || card.act.title_en || '').trim()
}

/** Тема по словарю; нет совпадения — английская тема как есть (её переводит модель, см. collectTranslatable). */
export function headlineRu(card: Card): string {
  const src = headlineEn(card)
  for (const [re, ru] of HEADLINE_RU) if (re.test(src)) return ru
  return src || RU.notFound
}

function dictHeadlineRu(card: Card): string | null {
  const src = headlineEn(card)
  for (const [re, ru] of HEADLINE_RU) if (re.test(src)) return ru
  return null
}

function requisitesFor(card: Card, x: Ctx): string {
  const { L } = x
  const a = card.act
  const type = factValue(a.type)
  const typeText = type ? (x.lang === 'en' ? actTypeEn(type) : (actTypeRu(type) ?? x.tr(type))) : L.act
  const number = factValue(a.number)
  const adopt = factValue(a.adoption_date)
  const first = [typeText, `${L.no} ${number ?? L.notFound}`, `${L.of} ${adopt ? fmtDate(adopt, L) : L.notFound}`].join(' ')
  const regNum = factValue(a.registration_number)
  const regDate = factValue(a.registration_date)
  if (!regNum && !regDate) return first
  return `${first}, ${L.reg} ${regNum ?? L.notFound} ${L.of} ${regDate ? fmtDate(regDate, L) : L.notFound}`
}

/** «Пост. Правления ЦБ № 24/2 от 17.09.2026, рег. МЮ № 3254-2 от 09.10.2026»; unknown → «не удалось установить» (HAL-08). */
export function requisites(card: Card, lang: DigestLang = 'ru'): string {
  return requisitesFor(card, makeCtx({ lang }))
}

function effectiveLine(card: Card, L: Labels): string {
  const a = card.act
  const eff = factValue(a.effective_date)
  const tp = factValue(a.transition_period.exists)
  const effText = eff ? L.effective(fmtDate(eff, L)) : L.effectiveUnknown
  const tpText = tp === 'yes' ? L.tpYes : tp === 'no' ? L.tpNo : L.tpUnknown
  return `${effText}, ${tpText}`
}

/** Счётчик значимости по changes[] (🔴 · 🟠 · ⚪). */
export function significanceCounts(card: Card): { n: number; l: number; z: number } {
  return {
    n: card.changes.filter((c) => c.significance === 'significant').length,
    l: card.changes.filter((c) => c.significance === 'less_significant').length,
    z: card.changes.filter((c) => c.significance === 'not_significant').length,
  }
}

function countsLine(card: Card, L: Labels): string {
  const parts: string[] = []
  const base = factValue(card.amends.base_act_number)
  parts.push(base ? L.amends(base) : L.newAct)
  // У нового акта «изменений» нет: пункты приложения — это его собственный текст.
  if (base && card.changes.length > 0) {
    const { n, l, z } = significanceCounts(card)
    const total = typeof card.change_count?.annex_items?.value === 'number' ? card.change_count.annex_items.value : card.changes.length
    parts.push(`${L.changes(total)} — 🔴 ${n} · 🟠 ${l} · ⚪ ${z}`)
  }
  return parts.join(' ')
}

/** «Annex item 4 (para 8)» → «п. 8»; «п. 8» остаётся; иначе — как есть. */
function locationRu(loc: string): string {
  const para = /para(?:graph)?s?\s+(\d+[\d\-, a-z]*)/i.exec(loc)
  if (para) return `п. ${para[1]!.trim().replace(/\)$/, '')}`
  const item = /(?:annex\s+)?(?:item|point)s?\s+(\d+)/i.exec(loc)
  if (item) return `п. ${item[1]} прил.`
  return loc
}

interface TopLine {
  location: string
  summary: string
  high: boolean
}

function topLines(card: Card): TopLine[] {
  if (card.top_changes && card.top_changes.length > 0) {
    return card.top_changes.slice(0, 3).map((c) => ({ location: c.location, summary: c.summary_en, high: c.implementation_difficulty === 'high' }))
  }
  return card.changes
    .filter((c) => c.significance === 'significant')
    .slice(0, 3)
    .map((c) => ({ location: c.location, summary: c.summary_en, high: c.implementation_difficulty === 'high' }))
}

// ---------- блоки ----------

function countsPhrase(c: DigestCountry, L: Labels): string {
  const items = c.result.items.length
  const info = c.result.for_information?.length ?? 0
  const unv = c.result.unverified?.length ?? 0
  const parts: string[] = []
  if (items > 0) parts.push(L.material(items))
  if (info > 0) parts.push(L.forInfo(info))
  if (unv > 0) parts.push(L.unverified(unv))
  return parts.join(', ')
}

function summaryLine(c: DigestCountry, x: Ctx): string {
  return `${c.flag ? c.flag + ' ' : ''}${countryName(c, x.lang)} — ${countsPhrase(c, x.L)}`
}

function itemLines(item: ResultItem, card: Card | undefined, x: Ctx): Line[] {
  const { L } = x
  const lines: Line[] = []
  if (!card) {
    lines.push({ parts: [x.tr(item.title_en || item.key)], style: 'title' })
    lines.push({ parts: [L.noCard], style: 'warn' })
    return lines
  }
  if (item.kind === 'update') {
    lines.push({ parts: [L.update(fmtDate(item.first_reported_at, L))], style: 'warn' })
  }
  const title = x.lang === 'en' ? headlineEn(card) || L.notFound : (dictHeadlineRu(card) ?? x.tr(headlineEn(card) || RU.notFound))
  lines.push({ parts: [title], style: 'title' })
  if (!item.confirmed) lines.push({ parts: [L.unconfirmed(item.disputed_fields)], style: 'warn' })
  lines.push({ parts: [requisitesFor(card, x)], style: 'body' })
  lines.push({ parts: [effectiveLine(card, L)], style: 'body' })
  lines.push({ parts: [countsLine(card, L)], style: 'body' })
  for (const t of topLines(card)) {
    const loc = x.lang === 'en' ? t.location : locationRu(t.location)
    lines.push({ parts: [`🔴 ${loc} — ${x.tr(t.summary)}${t.high ? L.hard : ''}`], style: 'body' })
  }
  const l = card.links
  const links: Part[] = [L.read]
  const add = (label: string, url: string | undefined) => {
    if (!url) return
    if (links.length > 1) links.push(' · ')
    const href = safeHref(url)
    if (href) {
      links.push(`${label} `, { t: href, href })
    } else {
      links.push(`${label} ${url}`)
    }
  }
  add(L.linkAmending, l?.amending_act)
  add(L.linkCurrent, l?.current_version)
  add(L.linkNew, l?.version_on_effective_date)
  if (links.length > 1) lines.push({ parts: links, style: 'body' })
  return lines
}

/** Краткая тема акта «для сведения» по-английски: строка экрана (reason), иначе первый пункт. */
export function forInfoTopic(f: ForInfoItem): string {
  return (f.reason ?? '').trim() || (f.points?.[0] ?? '').trim()
}

function infoLine(f: ForInfoItem, x: Ctx): Line {
  const topic = forInfoTopic(f)
  // Точка в конце предложения перед « — » лишняя; переводится фрагмент целиком (как в collectTranslatable).
  const head = topic ? `${x.tr(topic).replace(/[.\s]+$/u, '')} — ` : ''
  const meta = [f.issuer, f.date ? fmtDate(f.date, x.L) : ''].filter(Boolean).join(', ')
  const parts: Part[] = [`· ${head}${f.title_original} — ${meta} — `]
  const href = safeHref(f.url)
  parts.push(href ? { t: href, href } : f.url || x.L.notFound)
  return { parts, style: 'bullet' }
}

/** Причина «не удалось проверить»: код пишет её по-русски → для en — словарь сообщений; английская — на перевод для ru. */
function unverifiedReason(u: UnverifiedItem, x: Ctx): string {
  const r = (u.reason ?? '').trim()
  if (!r) return x.L.notFound
  return x.lang === 'en' ? translateMsg(r, 'en') : x.tr(r)
}

function unverifiedLine(u: UnverifiedItem, x: Ctx): Line {
  const parts: Part[] = [`· ${u.title_original} — ${unverifiedReason(u, x)} — `]
  const href = safeHref(u.url)
  parts.push(href ? { t: href, href } : u.url || x.L.notFound)
  return { parts, style: 'bullet' }
}

export function hasFindings(c: DigestCountry): boolean {
  return c.result.items.length > 0 || (c.result.for_information?.length ?? 0) > 0 || (c.result.unverified?.length ?? 0) > 0
}

function subjectFor(countries: DigestCountry[], L: Labels): string {
  return `RegWatch: ${countries.map((c) => `${c.code} — ${countsPhrase(c, L)}`).join(', ')}`
}

// ---------- рендер ----------

function renderText(lines: Line[]): string {
  const out: string[] = []
  for (const ln of lines) {
    const s = ln.parts.map((p) => (typeof p === 'string' ? p : p.t)).join('')
    if (ln.style === 'country' && out.length > 0) out.push('')
    if (ln.style === 'heading') out.push('')
    out.push(s)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n'
}

const STYLE: Record<Style, string> = {
  country: 'margin:24px 0 6px;padding-top:12px;border-top:2px solid #ccc;font-size:17px;font-weight:bold;',
  title: 'margin:10px 0 2px;font-size:16px;font-weight:bold;',
  body: 'margin:2px 0;font-size:14px;line-height:1.4;',
  bullet: 'margin:3px 0 3px 8px;font-size:14px;line-height:1.4;',
  heading: 'margin:12px 0 2px;font-size:14px;font-weight:bold;',
  muted: 'margin:4px 0;font-size:12px;color:#666;line-height:1.4;',
  warn: 'margin:2px 0;font-size:14px;color:#b45309;',
}

function renderHtml(lines: Line[], heading: string, lang: DigestLang): string {
  const body = lines
    .map((ln) => {
      const inner = ln.parts
        .map((p) => (typeof p === 'string' ? esc(p) : `<a href="${esc(p.href)}" style="color:#1a56b0;word-break:break-all;">${esc(p.t)}</a>`))
        .join('')
      return `<p style="${STYLE[ln.style]}">${inner}</p>`
    })
    .join('\n')
  return (
    `<!doctype html>\n<html lang="${lang}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${esc(heading)}</title></head>\n` +
    '<body style="margin:0;padding:0;background:#f4f4f4;">' +
    '<div style="max-width:640px;margin:0 auto;padding:16px;background:#ffffff;font-family:-apple-system,Helvetica,Arial,sans-serif;color:#111;">\n' +
    `<h1 style="margin:0 0 8px;font-size:20px;">${esc(heading)}</h1>\n${body}\n</div></body></html>`
  )
}

export function buildDigest(input: DigestInput, opts?: DigestOptions): DigestOutput {
  const x = makeCtx(opts)
  const { L } = x
  const shown = input.countries.filter(hasFindings)
  const hasContent = shown.length > 0
  const lines: Line[] = []
  let unofficial = false

  for (const c of shown) {
    lines.push({ parts: [summaryLine(c, x)], style: 'country' })
    for (const item of c.result.items) {
      const card = c.cards[item.candidate_id]
      if (card && card.act.official_russian_text !== 'yes') unofficial = true
      lines.push(...itemLines(item, card, x))
    }
    const info = c.result.for_information ?? []
    if (info.length > 0) {
      lines.push({ parts: [L.forInfoHeading], style: 'heading' })
      for (const f of info) lines.push(infoLine(f, x))
    }
    const unv = c.result.unverified ?? []
    if (unv.length > 0) {
      lines.push({ parts: [L.unverifiedHeading], style: 'heading' })
      for (const u of unv) lines.push(unverifiedLine(u, x))
    }
  }

  const foot: string[] = [L.checked(input.checked.ok, input.checked.total)]
  if (input.failures.length > 0) {
    const reason = (r: string): string => (x.lang === 'en' ? translateMsg(r, 'en') : r)
    foot.push(L.failed + input.failures.map((f) => `${countryName(f, x.lang)} (${reason(f.reason)})`).join('; '))
  }
  foot.push(L.disclaimer)
  // «Перевод неофициальный» (ANA-08) — только в русском письме: английское письмо — исходный отчёт.
  if (unofficial && x.lang === 'ru') foot.push(L.unofficial)
  foot.push(L.details)
  lines.push({ parts: [foot.join(' · ')], style: 'muted' })

  const heading = L.heading(fmtDate(input.date, L))
  const subject = hasContent ? subjectFor(shown, L) : L.noChanges
  const text = `${heading}\n\n` + renderText(lines)
  return { subject, html: renderHtml(lines, heading, x.lang), text, hasContent }
}

/**
 * Уникальные английские фрагменты, которые русское письмо пропускает через перевод (в порядке появления в письме).
 * Считается тем же кодом, что строит письмо, — поэтому список всегда совпадает с тем, что спросит buildDigest.
 */
export function collectTranslatable(input: DigestInput): string[] {
  const seen = new Set<string>()
  buildDigest(input, {
    lang: 'ru',
    translate: (s) => {
      seen.add(s)
      return s
    },
  })
  return [...seen]
}
