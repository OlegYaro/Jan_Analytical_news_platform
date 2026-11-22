import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addCountry, addSource, addWatchedAct, loadCountries, removeCountry, removeSource, removeWatchedAct,
  setCountryActive, setSourceState, setWatchedActState, updateCountry, updateSource, updateWatchedAct,
} from './store.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'rw-countries-'))

test('создаёт файл из стартового набора', () => {
  const dir = tmp()
  const list = loadCountries(dir)
  assert.equal(list.length, 9)
  assert.ok(existsSync(join(dir, 'countries.json')))
  assert.equal(loadCountries(dir).length, 9)
})

test('битый файл уходит в .bak, создаётся стартовый набор', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'countries.json'), '{ не json')
  assert.equal(loadCountries(dir).length, 9)
  assert.ok(existsSync(join(dir, 'countries.json.bak')))
})

test('добавление страны', () => {
  const dir = tmp()
  const r = addCountry(dir, { code: 'cn', name: 'Китай', languages: ['zh'] })
  assert.ok(r.ok)
  assert.equal(r.countries.length, 10)
  assert.equal(loadCountries(dir).find((c) => c.code === 'CN')?.active, true)
})

test('дубль страны и неверный ISO-код', () => {
  const dir = tmp()
  assert.equal(addCountry(dir, { code: 'UZ', name: 'Узбекистан', languages: ['uz'] }).errors['code'], 'Такая страна уже есть в списке')
  assert.ok(addCountry(dir, { code: 'U1', name: 'X', languages: ['uz'] }).errors['code'])
  assert.ok(addCountry(dir, { code: 'XYZ', name: 'X', languages: ['uz'] }).errors['code'])
  assert.ok(addCountry(dir, { code: 'CN', name: ' ', languages: [] }).errors['name'])
  assert.equal(loadCountries(dir).length, 9)
})

test('удаление страны не трогает архив прогонов', () => {
  const dir = tmp()
  const work = tmp()
  mkdirSync(join(work, 'runs', 'UZ'), { recursive: true })
  writeFileSync(join(work, 'runs', 'UZ', 'x'), 'архив')
  const r = removeCountry(dir, 'UZ')
  assert.ok(r.ok)
  assert.equal(r.countries.length, 8)
  assert.ok(existsSync(join(work, 'runs', 'UZ', 'x')))
  assert.deepEqual(readdirSync(join(work, 'runs', 'UZ')), ['x'])
  assert.equal(removeCountry(dir, 'UZ').ok, false)
})

test('включение/выключение и правка страны', () => {
  const dir = tmp()
  assert.equal(setCountryActive(dir, 'KZ', false).countries.find((c) => c.code === 'KZ')?.active, false)
  const r = updateCountry(dir, 'KZ', { name: 'Казахстан!', languages: ['kk', 'ru', 'en'] })
  assert.ok(r.ok)
  assert.deepEqual(r.countries.find((c) => c.code === 'KZ')?.languages, ['kk', 'ru', 'en'])
  assert.equal(updateCountry(dir, 'KZ', { languages: [] }).ok, false)
})

test('источник: добавление и проверки', () => {
  const dir = tmp()
  const ok = addSource(dir, 'KZ', { url: 'https://example.kz/path', type: 'news', language: 'ru' })
  assert.ok(ok.ok)
  const s = ok.countries.find((c) => c.code === 'KZ')!.sources.at(-1)!
  assert.equal(s.name, 'example.kz')
  assert.equal(s.state, 'unchecked')
  assert.equal(addSource(dir, 'KZ', { url: 'example.kz', type: 'news', language: 'ru' }).errors['url'], 'Адрес должен начинаться с https://')
  assert.ok(addSource(dir, 'KZ', { url: 'https://', type: 'news', language: 'ru' }).errors['url'])
  assert.ok(addSource(dir, 'KZ', { url: 'https://a.kz', type: 'blog' as never, language: 'ru' }).errors['type'])
  assert.ok(addSource(dir, 'KZ', { url: 'https://a.kz', type: 'news', language: '' }).errors['language'])
  assert.ok(addSource(dir, 'KZ', { url: 'https://ADILET.zan.kz/', type: 'news', language: 'ru' }).errors['url'])
  // тот же адрес у другой страны — можно
  assert.ok(addSource(dir, 'KG', { url: 'https://adilet.zan.kz', type: 'news', language: 'ru' }).ok)
})

test('смена URL сбрасывает состояние, другие правки — нет', () => {
  const dir = tmp()
  const c = loadCountries(dir).find((x) => x.code === 'KZ')!
  const id = c.sources[0]!.id
  // имитируем проверенный источник
  const file = join(dir, 'countries.json')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.countries.find((x: { code: string }) => x.code === 'KZ').sources[0].state = 'ok'
  writeFileSync(file, JSON.stringify(raw))
  const a = updateSource(dir, 'KZ', id, { enabled: false })
  assert.equal(a.countries.find((x) => x.code === 'KZ')!.sources[0]!.state, 'ok')
  const b = updateSource(dir, 'KZ', id, { url: 'https://new.example.kz' })
  assert.ok(b.ok)
  assert.equal(b.countries.find((x) => x.code === 'KZ')!.sources[0]!.state, 'unchecked')
  // тот же URL — не сброс и не дубль самого себя
  assert.ok(updateSource(dir, 'KZ', id, { url: 'https://new.example.kz' }).ok)
  assert.equal(updateSource(dir, 'KZ', id, { url: 'https://www.nationalbank.kz' }).ok, false)
  assert.equal(updateSource(dir, 'KZ', 'нет', { enabled: true }).ok, false)
})

test('удаление источника', () => {
  const dir = tmp()
  const id = loadCountries(dir).find((c) => c.code === 'TJ')!.sources[0]!.id
  const r = removeSource(dir, 'TJ', id)
  assert.equal(r.countries.find((c) => c.code === 'TJ')!.sources.length, 1)
})

test('акты: обязательны название и ссылка', () => {
  const dir = tmp()
  assert.ok(addWatchedAct(dir, 'KZ', { title: '', url: 'https://a.kz/1' }).errors['title'])
  assert.ok(addWatchedAct(dir, 'KZ', { title: 'Закон', url: '' }).errors['url'])
  assert.ok(addWatchedAct(dir, 'KZ', { title: 'Закон', url: 'a.kz/1' }).errors['url'])
  const r = addWatchedAct(dir, 'KZ', { title: 'Закон', registrationNumber: '12', url: 'https://a.kz/1' })
  assert.ok(r.ok)
  const id = r.countries.find((c) => c.code === 'KZ')!.watchedActs[0]!.id
  const u = updateWatchedAct(dir, 'KZ', id, { title: 'Закон 2' })
  assert.equal(u.countries.find((c) => c.code === 'KZ')!.watchedActs[0]!.title, 'Закон 2')
  assert.equal(updateWatchedAct(dir, 'KZ', id, { url: '' }).ok, false)
  assert.equal(removeWatchedAct(dir, 'KZ', id).countries.find((c) => c.code === 'KZ')!.watchedActs.length, 0)
})

test('профиль извлечения: старые записи без поля валидны; смена адреса сбрасывает профиль', () => {
  const dir = tmp()
  const file = join(dir, 'countries.json')
  loadCountries(dir)
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const kz = raw.countries.find((x: { code: string }) => x.code === 'KZ')
  assert.equal('profile' in kz.sources[0], false) // стартовый набор без профиля
  kz.sources[0].profile = { kind: 'rss', url: 'https://www.nationalbank.kz/rss' }
  writeFileSync(file, JSON.stringify(raw))
  const id = kz.sources[0].id as string
  const kept = updateSource(dir, 'KZ', id, { enabled: false })
  assert.deepEqual(kept.countries.find((x) => x.code === 'KZ')!.sources[0]!.profile, { kind: 'rss', url: 'https://www.nationalbank.kz/rss' })
  const moved = updateSource(dir, 'KZ', id, { url: 'https://new.example.kz' })
  assert.equal(moved.countries.find((x) => x.code === 'KZ')!.sources[0]!.profile, null)
})

test('setSourceState (SRC-08): ⚠ с причиной; повтор той же записи не меняет checkedAt и файл', () => {
  const dir = tmp()
  const id = loadCountries(dir).find((c) => c.code === 'KG')!.sources[1]!.id
  const r1 = setSourceState(dir, 'KG', id, 'warn', 'Список не разобран', new Date('2026-11-18T08:00:00Z'))
  assert.ok(r1.ok && r1.changed)
  const s1 = loadCountries(dir).find((c) => c.code === 'KG')!.sources[1]!
  assert.equal(s1.state, 'warn')
  assert.equal(s1.stateReason, 'Список не разобран')
  assert.equal(s1.checkedAt, '2026-11-18T08:00:00.000Z')
  const before = readFileSync(join(dir, 'countries.json'), 'utf8')
  const r2 = setSourceState(dir, 'KG', id, 'warn', 'Список не разобран', new Date('2026-11-25T08:00:00Z'))
  assert.ok(r2.ok && !r2.changed)
  assert.equal(readFileSync(join(dir, 'countries.json'), 'utf8'), before)
  assert.equal(setSourceState(dir, 'KG', 'нет', 'warn', 'x').ok, false)
})

test('setSourceState с итогом проверки источников (фаза 6): пишет всегда, seenLatest ≤ 5, профиль; адрес сменили — не пишет', () => {
  const dir = tmp()
  const kg = () => loadCountries(dir).find((c) => c.code === 'KG')!
  const s0 = kg().sources[1]!
  const seen = Array.from({ length: 7 }, (_, i) => ({ title: `Док ${i}`, date: `2026-11-0${i + 1}`, url: `https://x/${i}`, extra: 'лишнее' }))
  const profile = { kind: 'rss' as const, url: 'https://www.nbkr.kg/rss' }
  const r1 = setSourceState(dir, 'KG', s0.id, 'ok', 'Работает', new Date('2026-11-18T08:00:00Z'), { seenLatest: seen, profile, expectUrl: s0.url })
  assert.ok(r1.ok && r1.changed)
  let s = kg().sources[1]!
  assert.equal(s.state, 'ok')
  assert.equal(s.seenLatest.length, 5)
  assert.deepEqual(Object.keys(s.seenLatest[0]!).sort(), ['date', 'title', 'url'])
  assert.deepEqual(s.profile, profile)
  // повтор с тем же состоянием — проверка была: дата обновляется
  const r2 = setSourceState(dir, 'KG', s0.id, 'ok', 'Работает', new Date('2026-11-19T08:00:00Z'), { seenLatest: [] })
  assert.ok(r2.ok && r2.changed)
  s = kg().sources[1]!
  assert.equal(s.checkedAt, '2026-11-19T08:00:00.000Z')
  assert.deepEqual(s.seenLatest, [])
  assert.deepEqual(s.profile, profile, 'profile не передан — не трогается')
  setSourceState(dir, 'KG', s0.id, 'warn', 'Нет способа чтения', new Date(), { profile: null })
  assert.equal(kg().sources[1]!.profile, null)
  // адрес сменили во время проверки — результат не пишется
  const r3 = setSourceState(dir, 'KG', s0.id, 'fail', 'Сайт не открывается', new Date(), { expectUrl: 'https://old.example' })
  assert.ok(!r3.ok && !r3.changed)
  assert.equal(kg().sources[1]!.state, 'warn')
})

test('setWatchedActState (SRC-06): состояние, причина, дата; смена ссылки во время проверки — не пишет', () => {
  const dir = tmp()
  const a = loadCountries(dir).find((c) => c.code === 'UZ')!.watchedActs[0]!
  assert.ok(setWatchedActState(dir, 'UZ', a.id, 'fail', 'Номер не совпадает', new Date('2026-11-18T08:00:00Z'), a.url).ok)
  const b = loadCountries(dir).find((c) => c.code === 'UZ')!.watchedActs[0]!
  assert.equal(b.state, 'fail')
  assert.equal(b.stateReason, 'Номер не совпадает')
  assert.equal(b.checkedAt, '2026-11-18T08:00:00.000Z')
  assert.equal(setWatchedActState(dir, 'UZ', a.id, 'ok', 'x', new Date(), 'https://other').ok, false)
  assert.equal(setWatchedActState(dir, 'UZ', 'нет', 'ok', 'x').ok, false)
  updateWatchedAct(dir, 'UZ', a.id, { url: 'https://lex.uz/docs/1' })
  assert.equal(loadCountries(dir).find((c) => c.code === 'UZ')!.watchedActs[0]!.checkedAt, null)
})

function writeV1(dir: string, codes: string[]): void {
  const seed = loadCountries(tmp()).filter((c) => codes.includes(c.code))
  writeFileSync(join(dir, 'countries.json'), JSON.stringify({ schemaVersion: 1, countries: seed }))
}

test('миграция countries v1→v2: добавляет Монголию, остальное не трогает, версия 2', () => {
  const dir = tmp()
  writeV1(dir, ['UZ', 'KZ'])
  const file = join(dir, 'countries.json')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.countries[1].active = false
  raw.countries[0].sources[0].state = 'ok'
  writeFileSync(file, JSON.stringify(raw))
  const list = loadCountries(dir)
  assert.deepEqual(list.map((c) => c.code), ['UZ', 'KZ', 'MN'])
  assert.equal(list[1]!.active, false)
  assert.equal(list[0]!.sources[0]!.state, 'ok')
  const mn = list[2]!
  assert.deepEqual(mn.languages, ['mn', 'en'])
  assert.equal(mn.sources.length, 4)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).schemaVersion, 2)
})

test('миграция countries v1→v2: не дублирует существующую MN', () => {
  const dir = tmp()
  writeV1(dir, ['UZ', 'MN'])
  const list = loadCountries(dir)
  assert.equal(list.filter((c) => c.code === 'MN').length, 1)
  assert.equal(list.length, 2)
})

test('после v2 удалённая Монголия не возвращается', () => {
  const dir = tmp()
  writeV1(dir, ['UZ'])
  assert.equal(loadCountries(dir).length, 2)
  assert.ok(removeCountry(dir, 'MN').ok)
  assert.deepEqual(loadCountries(dir).map((c) => c.code), ['UZ'])
  assert.deepEqual(loadCountries(dir).map((c) => c.code), ['UZ'])
})

test('issuerClasses: сохраняется, чистится, сбрасывается; ошибки по-русски', () => {
  const dir = tmp()
  loadCountries(dir)
  const r = updateCountry(dir, 'KZ', { issuerClasses: { class1: ['  Нацбанк ', 'нацбанк', ''], class2: ['закон'] } })
  assert.equal(r.ok, true)
  assert.deepEqual(loadCountries(dir).find((c) => c.code === 'KZ')!.issuerClasses, { class1: ['Нацбанк'], class2: ['закон'] })
  const long = updateCountry(dir, 'KZ', { issuerClasses: { class1: ['я'.repeat(121)], class2: [] } })
  assert.equal(long.ok, false)
  assert.match(long.errors['class1']!, /длиннее 120/)
  const many = updateCountry(dir, 'KZ', { issuerClasses: { class1: [], class2: Array.from({ length: 51 }, (_, i) => `орган ${i}`) } })
  assert.match(many.errors['class2']!, /не больше 50/)
  const bad = updateCountry(dir, 'KZ', { issuerClasses: { class1: [1 as unknown as string], class2: [] } })
  assert.equal(bad.ok, false)
  assert.deepEqual(loadCountries(dir).find((c) => c.code === 'KZ')!.issuerClasses, { class1: ['Нацбанк'], class2: ['закон'] })
  const reset = updateCountry(dir, 'KZ', { issuerClasses: null })
  assert.equal(reset.ok, true)
  assert.equal('issuerClasses' in loadCountries(dir).find((c) => c.code === 'KZ')!, false)
  // правка имени не трогает правила
  updateCountry(dir, 'KZ', { issuerClasses: { class1: ['а'], class2: [] } })
  updateCountry(dir, 'KZ', { name: 'Казахстан' })
  assert.deepEqual(loadCountries(dir).find((c) => c.code === 'KZ')!.issuerClasses, { class1: ['а'], class2: [] })
})
