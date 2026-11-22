import { test } from 'node:test'
import assert from 'node:assert/strict'
import { currentLang, pick } from './i18n.ts'

test('без localStorage язык русский; pick выбирает вариант по языку', () => {
  assert.equal(currentLang(), 'ru')
  assert.equal(pick({ a: 'Привет', f: (n: number) => `Шаг ${n}` }, { a: 'Hello', f: (n: number) => `Step ${n}` }).a, 'Привет')
  const en = pick({ a: 'Привет', f: (n: number) => `Шаг ${n}` }, { a: 'Hello', f: (n: number) => `Step ${n}` }, 'en')
  assert.equal(en.a, 'Hello')
  assert.equal(en.f(2), 'Step 2')
})
