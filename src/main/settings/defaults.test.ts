import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEFAULT_PERSPECTIVE_RU, DEFAULT_TOPIC_RU } from '../../shared/types.ts'
import { defaultSettings } from './defaults.ts'
import { MAIL_SERVICES, PRESET_MODELS, modelForStage } from './presets.ts'

const norm = (t: string): string => t.replace(/\s+/g, ' ').trim()
const doc = readFileSync(new URL('../../../docs/05-ui-and-settings.md', import.meta.url), 'utf8')

test('тема по умолчанию дословно из docs/05 §7 (с точностью до пробелов)', () => {
  const block = doc.split('## 7.')[1]!.split('```')[1]!
  assert.equal(norm(defaultSettings('/h').topic), norm(block))
  assert.ok(defaultSettings('/h').topic.includes('\n- '))
})

test('русская подпись темы из docs/05 §7', () => {
  assert.ok(doc.split('## 7.')[1]!.includes(DEFAULT_TOPIC_RU))
})

test('perspective по умолчанию дословно из docs/05 §6.1', () => {
  const row = doc.split('\n').find((l) => l.startsWith('| Для кого оценивать'))!
  const m = /«(Private equity[^»]*)»/.exec(row)!
  assert.equal(norm(defaultSettings('/h').perspective), norm(m[1]!))
  assert.ok(row.includes(DEFAULT_PERSPECTIVE_RU))
})

test('значения по умолчанию и рабочая папка', () => {
  const d = defaultSettings('/Users/x')
  assert.equal(d.workspaceDir, '/Users/x/RegWatch')
  assert.deepEqual(d.schedules, [{ id: 'main', name: 'Основная проверка', enabled: true, days: [1], time: '08:00', countries: [] }])
  assert.equal(d.uiLanguage, 'ru')
  assert.equal(d.limitPercent, 80)
  assert.equal(d.preset, 'balanced')
  assert.equal(d.reportLanguage, 'ru')
  assert.equal(d.mail.verified, false)
  assert.equal(d.advanced.firstRunDays, 30)
})

test('пресеты и почтовые сервисы', () => {
  assert.equal(PRESET_MODELS.economy.triage, 'haiku')
  assert.equal(PRESET_MODELS.max.translate, 'sonnet')
  assert.equal(PRESET_MODELS.balanced.analyze, 'opus')
  assert.equal(MAIL_SERVICES.find((s) => s.id === 'yandex')!.server, 'smtp.yandex.ru')
  assert.equal(MAIL_SERVICES.find((s) => s.id === 'outlook')!.security, 'starttls')
})

test('этапы экрана: модели пресетов и нижняя граница перепроверки (SCR-02, CFG-15)', () => {
  assert.equal(PRESET_MODELS.economy.screen, 'haiku');
  assert.equal(PRESET_MODELS.economy.confirm, 'sonnet');
  assert.equal(PRESET_MODELS.balanced.screen, 'sonnet');
  assert.equal(PRESET_MODELS.max.screen, 'sonnet');
  assert.equal(modelForStage('economy', 'screen'), 'haiku');
  // Даже если пользователь выбрал haiku для перепроверки, используется sonnet.
  assert.equal(modelForStage('economy', 'confirm', { confirm: 'haiku' }), 'sonnet');
  assert.equal(modelForStage('economy', 'confirm', { confirm: 'opus' }), 'opus');
});
