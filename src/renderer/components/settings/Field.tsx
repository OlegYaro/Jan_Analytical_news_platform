import type { ReactNode } from 'react'
import { ts } from '../../strings-settings.ts'

interface FieldProps {
  label: string
  hint?: string
  example?: string
  defaultValue?: string
  error?: string
  htmlFor?: string
  /** Компактный вид (мастер): без примера и значения по умолчанию. */
  compact?: boolean
  children: ReactNode
}

/** Поле настроек: название, элемент ввода, подсказка, пример, «по умолчанию», ошибка (CFG-02). */
export function Field({ label, hint, example, defaultValue, error, htmlFor, compact, children }: FieldProps) {
  return (
    <div className="st-field">
      <label className="st-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="st-control">{children}</div>
      {hint && <div className="st-hint">{hint}</div>}
      {!compact && example && (
        <div className="st-hint">
          {ts.examplePrefix}: {example}
        </div>
      )}
      {!compact && defaultValue && (
        <div className="st-hint">
          {ts.defaultPrefix}: {defaultValue}
        </div>
      )}
      {error && (
        <div className="st-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}

interface ShellProps {
  id: string
  title: string
  compact?: boolean
  failed?: boolean
  onReset?: () => void
  children: ReactNode
}

/** Оболочка секции: заголовок, содержимое, «Вернуть стандартные». */
export function SectionShell({ id, title, compact, failed, onReset, children }: ShellProps) {
  return (
    <section className={compact ? 'card st-section st-compact' : 'card st-section'} id={id}>
      <div className="card-head">
        <h2>{title}</h2>
        {onReset && !compact && (
          <button type="button" onClick={onReset}>
            {ts.reset}
          </button>
        )}
      </div>
      {failed && <div className="banner warn">{ts.saveError}</div>}
      {children}
    </section>
  )
}
