// Загрузка и проверка JSON Schema ответов модели. Без electron.
// schemasDir: в разработке <repo>/schemas, в упакованном приложении process.resourcesPath/schemas.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Ajv } from 'ajv'

export const SCHEMA_NAMES = [
  'triage',
  'screen',
  'card',
  'verification',
  'verify-sources',
  'discover-sources',
  'news-sweep',
  'translation',
] as const

export type SchemaName = (typeof SCHEMA_NAMES)[number]

export type ValidationResult = { ok: true } | { ok: false; error: string }

const MAX_ERROR_LEN = 800
const MAX_ERROR_ITEMS = 12

export function loadSchema(name: SchemaName, schemasDir: string): Record<string, unknown> {
  if (!(SCHEMA_NAMES as readonly string[]).includes(name)) throw new Error(`Unknown schema: ${name}`)
  return JSON.parse(readFileSync(join(schemasDir, `${name}.json`), 'utf8')) as Record<string, unknown>
}

export function schemaForCli(name: SchemaName, schemasDir: string): string {
  return JSON.stringify(loadSchema(name, schemasDir))
}

export function createValidator(name: SchemaName, schemasDir: string): (data: unknown) => ValidationResult {
  const ajv = new Ajv({ allErrors: true, strict: true })
  const validate = ajv.compile(loadSchema(name, schemasDir))
  return (data) => {
    if (validate(data)) return { ok: true }
    const seen = new Set<string>()
    const lines: string[] = []
    for (const e of validate.errors ?? []) {
      // Ошибки if/then и anyOf — шум поверх конкретных ошибок.
      if (e.keyword === 'if' || e.keyword === 'anyOf') continue
      let msg = e.message ?? 'invalid'
      if (e.keyword === 'additionalProperties') msg = `unexpected property "${String((e.params as { additionalProperty?: string }).additionalProperty)}"`
      else if (e.keyword === 'enum') msg = `${msg}: ${JSON.stringify((e.params as { allowedValues?: unknown }).allowedValues)}`
      const line = `${e.instancePath || '/'}: ${msg}`
      if (seen.has(line)) continue
      seen.add(line)
      lines.push(line)
      if (lines.length >= MAX_ERROR_ITEMS) break
    }
    if (lines.length === 0) lines.push('/: does not match schema')
    let text = `Schema "${name}" validation failed: ${lines.join('; ')}`
    if (text.length > MAX_ERROR_LEN) text = text.slice(0, MAX_ERROR_LEN - 3) + '...'
    return { ok: false, error: text }
  }
}
