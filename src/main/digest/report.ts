// Подробный отчёт страны для архива (ARC-04): report.en.md — «второй уровень» после письма. В письмо не идёт.
// Каждая карточка целиком: реквизиты с цитатами и ссылками, изменяемый акт, сфера, счётчик, все изменения со
// значимостью, сложностью и цитатами, ссылки, поля «unknown», заметки; затем «для сведения» и «не удалось проверить».
// Чистая логика, без модели: значения карточек — английские (исходный отчёт, LNG-01), цитаты — на языке оригинала.

import type { Card, Fact } from '../../shared/schema-types.ts'
import type { ResultItem } from '../../shared/pipeline-types.ts'
import { translateMsg } from '../runner/messages-en.ts'
import { headlineEn, significanceCounts, type DigestCountry } from './build.ts'
import type { DigestLang } from './contracts.ts'

interface RL {
  title: (name: string, code: string) => string
  summary: string
  none: string
  material: string
  noCard: string
  update: (date: string, why: string) => string
  unconfirmed: (fields: string[]) => string
  confirmed: (rounds: number) => string
  requisites: string
  type: string
  issuer: string
  number: string
  titleOriginal: string
  titleEn: string
  adoption: string
  registrationNumber: string
  registrationDate: string
  publication: string
  effective: string
  transition: string
  transitionDetails: string
  language: string
  officialRu: string
  stage: string
  updateOf: string
  amends: string
  baseTitle: string
  baseNumber: string
  baseUrl: string
  prior: string
  newAct: string
  scope: string
  appliesTo: string
  notAppliesTo: string
  count: string
  annexItems: string
  legalMarks: string
  explanation: string
  changes: (n: number, a: number, b: number, c: number) => string
  significance: string
  difficulty: string
  quote: string
  source: string
  links: string
  linkAmending: string
  linkCurrent: string
  linkNew: string
  unknowns: string
  notes: string
  forInfo: string
  points: string
  unverified: string
  reason: string
  footer: string
  unknown: string
  sig: Record<string, string>
  diff: Record<string, string>
  kind: Record<string, string>
}

const EN: RL = {
  title: (n, c) => `# RegWatch — ${n} (${c}): detailed report`,
  summary: 'Summary',
  none: 'No findings.',
  material: 'Material acts',
  noCard: 'Act card unavailable.',
  update: (d, w) => `🔄 Update, first reported ${d}${w ? ` (${w})` : ''}`,
  unconfirmed: (f) => `⚠ unconfirmed${f.length ? `: fields ${f.join(', ')}` : ''}`,
  confirmed: (r) => `Verified (rounds: ${r})`,
  requisites: 'Act details',
  type: 'Type',
  issuer: 'Issuer',
  number: 'Number',
  titleOriginal: 'Original title',
  titleEn: 'Title (English)',
  adoption: 'Adopted',
  registrationNumber: 'MoJ registration number',
  registrationDate: 'Registered',
  publication: 'Published',
  effective: 'Effective',
  transition: 'Transition period',
  transitionDetails: 'Transition details',
  language: 'Original language',
  officialRu: 'Official Russian text',
  stage: 'Stage',
  updateOf: 'Update of',
  amends: 'Amended act',
  baseTitle: 'Title',
  baseNumber: 'Registration number',
  baseUrl: 'Link',
  prior: 'Prior amendments',
  newAct: 'New act (does not amend another act).',
  scope: 'Scope',
  appliesTo: 'Applies to',
  notAppliesTo: 'Does not apply to',
  count: 'Change count',
  annexItems: 'Annex items',
  legalMarks: 'Legal-database change marks',
  explanation: 'How counted',
  changes: (n, a, b, c) => `Changes (${n}) — 🔴 ${a} · 🟠 ${b} · ⚪ ${c}`,
  significance: 'Significance',
  difficulty: 'Implementation difficulty',
  quote: 'Quote',
  source: 'Source',
  links: 'Links',
  linkAmending: 'Amending act',
  linkCurrent: 'Current version',
  linkNew: 'Version on the effective date',
  unknowns: 'Fields that could not be established',
  notes: 'Notes',
  forInfo: 'For information',
  points: 'Points',
  unverified: '⚠ Could not be verified',
  reason: 'Reason',
  footer: 'Not legal advice. Values are from the act card checked by the app; quotes are verbatim in the original language.',
  unknown: 'unknown',
  sig: { significant: '🔴 significant', less_significant: '🟠 less significant', not_significant: '⚪ not significant' },
  diff: { low: 'low', medium: 'medium', high: 'high' },
  kind: { rewritten: 'rewritten', added: 'added', repealed: 'repealed', new_chapter: 'new chapter' },
}

// Русские подписи — для окна приложения; значения карточки остаются английскими (перевод отчёта — не здесь).
const RU: RL = {
  ...EN,
  title: (n, c) => `# RegWatch — ${n} (${c}): подробный отчёт`,
  summary: 'Сводка',
  none: 'Находок нет.',
  material: 'Существенные акты',
  noCard: 'Карточка акта недоступна.',
  update: (d, w) => `🔄 Обновление, впервые сообщали ${d}${w ? ` (${w})` : ''}`,
  unconfirmed: (f) => `⚠ не подтверждено${f.length ? `: поля ${f.join(', ')}` : ''}`,
  confirmed: (r) => `Проверено (кругов: ${r})`,
  requisites: 'Реквизиты',
  type: 'Вид',
  issuer: 'Орган',
  number: 'Номер',
  titleOriginal: 'Название в оригинале',
  titleEn: 'Название по-английски',
  adoption: 'Принят',
  registrationNumber: 'Рег. номер МЮ',
  registrationDate: 'Зарегистрирован',
  publication: 'Опубликован',
  effective: 'Вступает в силу',
  transition: 'Переходный период',
  transitionDetails: 'Подробности переходного периода',
  language: 'Язык оригинала',
  officialRu: 'Официальный русский текст',
  stage: 'Стадия',
  updateOf: 'Обновление записи',
  amends: 'Изменяемый акт',
  baseTitle: 'Название',
  baseNumber: 'Рег. номер',
  baseUrl: 'Ссылка',
  prior: 'Прежние изменения',
  newAct: 'Новый акт (другой акт не изменяет).',
  scope: 'Сфера действия',
  appliesTo: 'Распространяется на',
  notAppliesTo: 'Не распространяется на',
  count: 'Счётчик изменений',
  annexItems: 'Пунктов приложения',
  legalMarks: 'Отметок об изменениях в правовой базе',
  explanation: 'Как считали',
  changes: (n, a, b, c) => `Изменения (${n}) — 🔴 ${a} · 🟠 ${b} · ⚪ ${c}`,
  significance: 'Значимость',
  difficulty: 'Сложность внедрения',
  quote: 'Цитата',
  source: 'Источник',
  links: 'Ссылки',
  linkAmending: 'Изменяющий акт',
  linkCurrent: 'Действующая редакция',
  linkNew: 'Редакция на дату вступления',
  unknowns: 'Не удалось установить',
  notes: 'Заметки',
  forInfo: 'Для сведения',
  points: 'Пункты',
  unverified: '⚠ Не удалось проверить',
  reason: 'Причина',
  footer: 'Не является юридической консультацией. Значения — из карточки акта, проверенной приложением; цитаты дословно на языке оригинала.',
  unknown: 'не удалось установить',
  sig: { significant: '🔴 значимое', less_significant: '🟠 менее значимое', not_significant: '⚪ незначимое' },
  diff: { low: 'низкая', medium: 'средняя', high: 'высокая' },
  kind: { rewritten: 'новая редакция', added: 'дополнение', repealed: 'утратил силу', new_chapter: 'новая глава' },
}

const COUNTRY_EN: Record<string, string> = {
  UZ: 'Uzbekistan', KZ: 'Kazakhstan', KG: 'Kyrgyzstan', TJ: 'Tajikistan', TM: 'Turkmenistan',
  GE: 'Georgia', AM: 'Armenia', AZ: 'Azerbaijan', MN: 'Mongolia',
}

/** Одна строка: переводы строк и лишние пробелы схлопываются (цитаты lex.uz бывают многострочными). */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Ссылка Markdown только для http(s); иначе — текстом в `кавычках`. */
function link(url: string | undefined, L: RL): string {
  const u = (url ?? '').trim()
  if (!u) return L.unknown
  return /^https?:\/\//i.test(u) ? `<${u}>` : `\`${u}\``
}

function val(v: unknown, L: RL): string {
  if (v === undefined || v === null) return L.unknown
  const s = String(v).trim()
  return !s || s === 'unknown' ? L.unknown : oneLine(s)
}

/** «- **Поле:** значение — “цитата” — <url>»; у unknown без цитаты — только значение. */
function factLine(label: string, f: Fact<unknown> | undefined, L: RL): string {
  if (!f) return `- **${label}:** ${L.unknown}`
  const parts = [`- **${label}:** ${val(f.value, L)}`]
  if (f.quote && f.quote.trim()) parts.push(`“${oneLine(f.quote)}”`)
  if (f.url && f.url.trim()) parts.push(link(f.url, L))
  return parts.join(' — ')
}

function cardSection(n: number, item: ResultItem, card: Card | undefined, L: RL): string[] {
  const out: string[] = []
  if (!card) {
    out.push(`## ${n}. ${oneLine(item.title_en || item.key)}`, '', L.noCard, '')
    return out
  }
  const a = card.act
  out.push(`## ${n}. ${oneLine(headlineEn(card) || L.unknown)}`, '')
  if (item.kind === 'update') out.push(L.update(item.first_reported_at ? dmy(item.first_reported_at) : L.unknown, item.update_reason ?? ''), '')
  out.push(item.confirmed ? L.confirmed(item.rounds) : L.unconfirmed(item.disputed_fields), '')

  out.push(`### ${L.requisites}`, '')
  out.push(
    factLine(L.type, a.type, L),
    factLine(L.issuer, a.issuer, L),
    factLine(L.number, a.number, L),
    factLine(L.titleOriginal, a.title_original, L),
    `- **${L.titleEn}:** ${val(a.title_en, L)}`,
    factLine(L.adoption, a.adoption_date, L),
    factLine(L.registrationNumber, a.registration_number, L),
    factLine(L.registrationDate, a.registration_date, L),
    factLine(L.publication, a.publication_date, L),
    factLine(L.effective, a.effective_date, L),
    factLine(L.transition, a.transition_period.exists, L),
  )
  if (a.transition_period.details?.trim()) out.push(`- **${L.transitionDetails}:** ${oneLine(a.transition_period.details)}`)
  out.push(
    `- **${L.language}:** ${val(a.original_language, L)}`,
    `- **${L.officialRu}:** ${val(a.official_russian_text, L)}`,
    `- **${L.stage}:** ${val(card.stage, L)}`,
  )
  if (card.update_of) out.push(`- **${L.updateOf}:** ${oneLine(card.update_of.ledger_key)} — ${oneLine(card.update_of.what_changed)}`)
  out.push('')

  out.push(`### ${L.amends}`, '')
  const am = card.amends
  if (am.base_act_number.value === 'unknown' && am.base_act_title.value === 'unknown' && !am.base_act_url) {
    out.push(L.newAct)
  } else {
    out.push(factLine(L.baseTitle, am.base_act_title, L), factLine(L.baseNumber, am.base_act_number, L), `- **${L.baseUrl}:** ${link(am.base_act_url, L)}`)
    if (am.prior_amendments.length) {
      out.push(`- **${L.prior}:**`)
      for (const p of am.prior_amendments) out.push(`  - ${oneLine(p.number)} — ${p.date === 'unknown' ? L.unknown : dmy(p.date)} — ${link(p.url, L)}`)
    }
  }
  out.push('')

  out.push(`### ${L.scope}`, '', factLine(L.appliesTo, card.scope.applies_to, L), factLine(L.notAppliesTo, card.scope.not_applies_to, L), '')

  out.push(`### ${L.count}`, '', factLine(L.annexItems, card.change_count.annex_items, L), factLine(L.legalMarks, card.change_count.legal_base_marks, L))
  if (card.change_count.explanation?.trim()) out.push(`- **${L.explanation}:** ${oneLine(card.change_count.explanation)}`)
  out.push('')

  const { n: sa, l: sb, z: sc } = significanceCounts(card)
  out.push(`### ${L.changes(card.changes.length, sa, sb, sc)}`, '')
  for (const c of card.changes) {
    out.push(`#### ${c.n}. ${oneLine(c.location)} — ${L.kind[c.kind] ?? c.kind}`, '')
    out.push(oneLine(c.summary_en), '')
    out.push(`- **${L.significance}:** ${L.sig[c.significance] ?? c.significance} — ${oneLine(c.significance_reason)}`)
    out.push(`- **${L.difficulty}:** ${L.diff[c.implementation_difficulty] ?? c.implementation_difficulty} — ${oneLine(c.difficulty_reason)}`)
    if (c.quote?.trim()) out.push(`- **${L.quote}:** “${oneLine(c.quote)}”`)
    out.push(`- **${L.source}:** ${link(c.url, L)}`, '')
  }

  out.push(`### ${L.links}`, '')
  out.push(`- ${L.linkAmending}: ${link(card.links?.amending_act, L)}`)
  out.push(`- ${L.linkCurrent}: ${link(card.links?.current_version, L)}`)
  out.push(`- ${L.linkNew}: ${link(card.links?.version_on_effective_date, L)}`, '')

  if (card.unknowns.length) out.push(`### ${L.unknowns}`, '', ...card.unknowns.map((u) => `- \`${u}\``), '')
  if (card.notes?.trim()) out.push(`### ${L.notes}`, '', oneLine(card.notes), '')
  return out
}

function dmy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso
}

/** Markdown-отчёт страны (report.en.md при lang='en'). lang='ru' меняет только подписи; содержание — исходное английское. */
export function buildCountryReport(country: DigestCountry, lang: DigestLang = 'en'): string {
  const L = lang === 'ru' ? RU : EN
  const r = country.result
  const name = lang === 'ru' ? country.nameRu : (country.nameEn ?? COUNTRY_EN[country.code] ?? country.nameRu)
  const info = r.for_information ?? []
  const unv = r.unverified ?? []
  const out: string[] = [L.title(`${country.flag ? country.flag + ' ' : ''}${name}`, country.code), '']

  const counts =
    lang === 'ru'
      ? [`существенных: ${r.items.length}`, `для сведения: ${info.length}`, `не удалось проверить: ${unv.length}`]
      : [`material: ${r.items.length}`, `for information: ${info.length}`, `could not be verified: ${unv.length}`]
  out.push(`**${L.summary}:** ${counts.join(' · ')}`, '')
  if (!r.items.length && !info.length && !unv.length) out.push(L.none, '')

  r.items.forEach((item, i) => out.push(...cardSection(i + 1, item, country.cards[item.candidate_id], L)))

  if (info.length) {
    out.push(`## ${L.forInfo}`, '')
    for (const f of info) {
      const meta = [f.issuer, f.date ? dmy(f.date) : ''].filter(Boolean).map(oneLine).join(', ')
      out.push(`- **${oneLine(f.title_original)}**${meta ? ` — ${meta}` : ''} — ${link(f.url, L)}`)
      if (f.reason?.trim()) out.push(`  - ${oneLine(f.reason)}`)
      if (f.points?.length) out.push(`  - ${L.points}: ${f.points.map(oneLine).join('; ')}`)
    }
    out.push('')
  }

  if (unv.length) {
    out.push(`## ${L.unverified}`, '')
    for (const u of unv) {
      const meta = [u.issuer, u.date ? dmy(u.date) : ''].filter(Boolean).map(oneLine).join(', ')
      const reason = u.reason?.trim() ? (lang === 'en' ? translateMsg(u.reason, 'en') : u.reason) : L.unknown
      out.push(`- **${oneLine(u.title_original)}**${meta ? ` — ${meta}` : ''} — ${link(u.url, L)}`, `  - ${L.reason}: ${oneLine(reason)}`)
    }
    out.push('')
  }

  if (r.warnings?.length) {
    out.push(lang === 'ru' ? '## Предупреждения' : '## Warnings', '', ...r.warnings.map((w) => `- ${oneLine(lang === 'en' ? translateMsg(w, 'en') : w)}`), '')
  }
  out.push('---', '', L.footer, '')
  return out.join('\n')
}
