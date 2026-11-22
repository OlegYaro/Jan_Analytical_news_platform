import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COUNTRY_CATALOG } from './catalog.ts'

test('справочник: уникальные коды, есть языки', () => {
  assert.ok(COUNTRY_CATALOG.length >= 40)
  assert.equal(new Set(COUNTRY_CATALOG.map((c) => c.code)).size, COUNTRY_CATALOG.length)
  for (const c of COUNTRY_CATALOG) {
    assert.match(c.code, /^[A-Z]{2}$/)
    assert.ok(c.nameRu.length > 0)
    assert.ok(c.languages.length > 0 && c.languages.every((l) => /^[a-z]{2}$/.test(l)), c.code)
  }
})

test('Монголия в справочнике: mn, en', () => {
  const mn = COUNTRY_CATALOG.find((c) => c.code === 'MN')!
  assert.equal(mn.nameRu, 'Монголия')
  assert.deepEqual(mn.languages, ['mn', 'en'])
})
