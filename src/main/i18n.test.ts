import { test } from 'node:test'
import assert from 'node:assert/strict'
import { langOf, mt } from './i18n.ts'

test('langOf: по умолчанию русский', () => {
  assert.equal(langOf(undefined), 'ru')
  assert.equal(langOf({}), 'ru')
  assert.equal(langOf({ uiLanguage: 'en' }), 'en')
  assert.equal(langOf({ uiLanguage: 'xx' }), 'ru')
})

test('mt выбирает строку и функцию по языку', () => {
  assert.equal(mt('ru', 'Да', 'Yes'), 'Да')
  assert.equal(mt('en', 'Да', 'Yes'), 'Yes')
  assert.equal(mt(undefined, 'Да', 'Yes'), 'Да')
  assert.equal(mt('en', (n: number) => `${n} шт`, (n: number) => `${n} pcs`)(3), '3 pcs')
})

import { validateSettings } from './settings/validate.ts'
import { translateMailError } from './mail/smtp.ts'
import { translateReasons } from './sources/reasons-ru.ts'
import { translateMsg } from './runner/messages-en.ts'
import { evaluateGate } from './mail-gate.ts'

test('валидатор: ключи те же, текст по языку', () => {
  const ru = validateSettings({ topic: ' ' })
  const en = validateSettings({ topic: ' ' }, 'en')
  assert.deepEqual(Object.keys(ru.errors), Object.keys(en.errors))
  assert.match(ru.errors['topic']!, /Опишите/)
  assert.match(en.errors['topic']!, /Describe/)
})

test('ошибки почты, причины источников и сообщения этапов на английском', () => {
  assert.match(translateMailError({ code: 'EDNS' }, { service: 'gmail' }, 'en'), /Could not/)
  assert.match(translateMailError({ code: 'EDNS' }, { service: 'gmail' }), /Не удалось/)
  assert.deepEqual(translateReasons(['site needs javascript'], ['reachable'], 'en').map((x) => /[А-Яа-я]/.test(x)), [false])
  assert.equal(translateMsg('Нет ни одной', 'ru'), 'Нет ни одной')
  assert.equal(translateMsg('Исчерпан лимит подписки Claude', 'en'), 'The Claude subscription limit is exhausted')
})

test('гейт почты: сообщение по языку настроек', () => {
  const mail = { verified: false, address: '' } as never
  assert.match(evaluateGate({ mail }, false).message, /Без настроенной почты/)
  assert.match(evaluateGate({ mail, uiLanguage: 'en' }, false).message, /Without configured mail/)
})
