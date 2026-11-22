import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedCountries } from './seed.ts'

const doc = readFileSync(join(import.meta.dirname, '../../../docs/08-countries-and-sources.md'), 'utf8')

function rows(section: string): string[][] {
  const part = doc.split(/^## /m).find((p) => p.startsWith(section)) ?? ''
  return part
    .split('\n')
    .filter((l) => l.startsWith('|') && !l.startsWith('|---'))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .slice(1)
}

test('9 стран, 28 источников, 2 акта UZ', () => {
  const s = seedCountries()
  assert.equal(s.length, 9)
  assert.equal(s.reduce((n, c) => n + c.sources.length, 0), 28)
  assert.equal(s.find((c) => c.code === 'UZ')!.watchedActs.length, 2)
  assert.ok(s.every((c) => c.active && c.sources.every((x) => x.state === 'unchecked' && x.checkedAt === null)))
})

test('все источники и акты из docs/08 присутствуют', () => {
  const s = seedCountries()
  const srcRows = rows('Источники')
  assert.equal(srcRows.length, 28)
  for (const [code, , url] of srcRows) {
    assert.ok(s.find((c) => c.code === code)!.sources.some((x) => x.url === url), `${code} ${url}`)
  }
  const actRows = rows('Отслеживаемые акты')
  assert.equal(actRows.length, 2)
  for (const [code, , , url] of actRows) {
    assert.ok(s.find((c) => c.code === code)!.watchedActs.some((x) => x.url === url), `${code} ${url}`)
  }
  const gaz = s.find((c) => c.code === 'UZ')!.sources.find((x) => x.url.includes('gazeta'))!
  assert.equal(gaz.priority, 'extra')
  assert.equal(s.flatMap((c) => c.sources).filter((x) => x.priority === 'extra').length, 1)
})

test('страны и их порядок сверены с таблицей docs/08; MN: язык источников mn', () => {
  const s = seedCountries()
  const part = doc.split('\n').filter((l) => /^\| [A-Z]{2} \| [^|]+ \| [a-z, ]+ \| да \|$/.test(l))
  assert.equal(part.length, 9)
  assert.deepEqual(s.map((c) => c.code), part.map((l) => l.split('|')[1]!.trim()))
  for (const l of part) {
    const [code, name, langs] = l.split('|').slice(1, -1).map((c) => c.trim())
    const c = s.find((x) => x.code === code)!
    assert.equal(c.name, name)
    assert.deepEqual(c.languages, langs!.split(',').map((x) => x.trim()))
  }
  const mn = s.find((c) => c.code === 'MN')!
  assert.deepEqual(mn.sources.map((x) => [x.type, x.name]), [
    ['legal_base', 'legalinfo.mn'], ['regulator', 'mongolbank.mn'], ['regulator', 'frc.mn'], ['drafts', 'parliament.mn'],
  ])
  assert.ok(mn.sources.every((x) => x.language === 'mn' && x.priority === 'main' && x.state === 'unchecked'))
})
