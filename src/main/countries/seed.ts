import type { Country, Source, SourceType, WatchedAct } from '../../shared/types.ts'

/** Стартовые данные дословно из docs/08-countries-and-sources.md (CTY-08). Ничего не добавлять «по памяти». */

function src(
  id: string,
  type: SourceType,
  url: string,
  language: string,
  opts: { priority?: 'main' | 'extra'; note?: string } = {},
): Source {
  return {
    id,
    name: new URL(url).hostname.replace(/^www\./, ''),
    url,
    type,
    language,
    priority: opts.priority ?? 'main',
    enabled: true,
    state: 'unchecked',
    stateReason: '',
    checkedAt: null,
    seenLatest: [],
    note: opts.note ?? '',
  }
}

function act(id: string, title: string, registrationNumber: string, url: string): WatchedAct {
  return { id, title, registrationNumber, url, state: 'unchecked', stateReason: '' }
}

function country(code: string, name: string, languages: string[], sources: Source[], watchedActs: WatchedAct[] = []): Country {
  return { code, name, languages, active: true, sources, watchedActs, lastCheckedAt: null, lastRunSummary: '' }
}

const CONFIRMED = 'подтверждён на практике, ещё не проверен приложением'

export function seedCountries(): Country[] {
  return [
    country(
      'UZ',
      'Узбекистан',
      ['uz', 'ru'],
      [
        src('seed-uz-1', 'legal_base', 'https://lex.uz', 'uz', { note: CONFIRMED }),
        src('seed-uz-2', 'regulator', 'https://cbu.uz', 'uz', { note: CONFIRMED }),
        src('seed-uz-3', 'drafts', 'https://regulation.gov.uz', 'uz'),
        src('seed-uz-4', 'news', 'https://www.gazeta.uz', 'ru', { priority: 'extra' }),
      ],
      [
        act(
          'seed-uz-act-1',
          'Положение о корпоративном управлении в коммерческих банках (пост. Правления ЦБ № 12/8 от 25.05.2020)',
          'рег. 3254',
          'https://www.lex.uz/docs/-4888804',
        ),
        act('seed-uz-act-2', 'Закон «Об акционерных обществах и защите прав акционеров» (рус.)', '', 'https://lex.uz/ru/docs/2382411'),
      ],
    ),
    country('KZ', 'Казахстан', ['kk', 'ru'], [
      src('seed-kz-1', 'legal_base', 'https://adilet.zan.kz', 'kk'),
      src('seed-kz-2', 'regulator', 'https://www.nationalbank.kz', 'kk'),
      src('seed-kz-3', 'regulator', 'https://www.gov.kz/memleket/entities/ardfm', 'kk', { note: 'АРРФР' }),
      src('seed-kz-4', 'drafts', 'https://legalacts.egov.kz', 'kk'),
    ]),
    country('KG', 'Кыргызстан', ['ky', 'ru'], [
      src('seed-kg-1', 'legal_base', 'https://cbd.minjust.gov.kg', 'ky'),
      src('seed-kg-2', 'regulator', 'https://www.nbkr.kg', 'ky'),
      src('seed-kg-3', 'drafts', 'https://koomtalkuu.gov.kg', 'ky'),
    ]),
    country('TJ', 'Таджикистан', ['tg', 'ru'], [
      src('seed-tj-1', 'legal_base', 'https://adliya.tj', 'tg', { note: 'возможен также portali.huquqi.tj — проверить' }),
      src('seed-tj-2', 'regulator', 'https://nbt.tj', 'tg'),
    ]),
    country('TM', 'Туркменистан', ['tk', 'ru'], [
      src('seed-tm-1', 'legal_base', 'https://minjust.gov.tm', 'tk', { note: 'источников мало' }),
      src('seed-tm-2', 'regulator', 'https://www.cbt.tm', 'tk'),
    ]),
    country('GE', 'Грузия', ['ka'], [
      src('seed-ge-1', 'legal_base', 'https://matsne.gov.ge', 'ka'),
      src('seed-ge-2', 'regulator', 'https://nbg.gov.ge', 'ka'),
      src('seed-ge-3', 'drafts', 'https://parliament.ge', 'ka'),
    ]),
    country('AM', 'Армения', ['hy'], [
      src('seed-am-1', 'legal_base', 'https://www.arlis.am', 'hy'),
      src('seed-am-2', 'regulator', 'https://www.cba.am', 'hy'),
      src('seed-am-3', 'drafts', 'https://www.e-draft.am', 'hy'),
    ]),
    country('AZ', 'Азербайджан', ['az'], [
      src('seed-az-1', 'legal_base', 'https://e-qanun.az', 'az'),
      src('seed-az-2', 'regulator', 'https://www.cbar.az', 'az'),
      src('seed-az-3', 'drafts', 'https://meclis.gov.az', 'az'),
    ]),
    country('MN', 'Монголия', ['mn', 'en'], [
      src('seed-mn-1', 'legal_base', 'https://legalinfo.mn', 'mn'),
      src('seed-mn-2', 'regulator', 'https://www.mongolbank.mn', 'mn', { note: 'центральный банк' }),
      src('seed-mn-3', 'regulator', 'https://www.frc.mn', 'mn', {
        note: 'Financial Regulatory Commission — небанковский сектор и рынок ценных бумаг',
      }),
      src('seed-mn-4', 'drafts', 'https://www.parliament.mn', 'mn'),
    ]),
  ]
}
