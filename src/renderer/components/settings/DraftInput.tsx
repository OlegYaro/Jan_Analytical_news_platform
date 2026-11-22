import { useState } from 'react'

interface Props {
  id?: string
  value: string
  onCommit: (v: string) => void
  multiline?: boolean
  type?: string
  placeholder?: string
  rows?: number
  className?: string
  invalid?: boolean
}

/** Текстовое поле с локальным черновиком: сохранение уходит наверх на каждое изменение (debounce — у вызывающего). */
export function DraftInput({ id, value, onCommit, multiline, type = 'text', placeholder, rows = 6, className, invalid }: Props) {
  const [draft, setDraft] = useState(value)
  const cls = `st-input${invalid ? ' invalid' : ''}${className ? ` ${className}` : ''}`
  const change = (v: string) => {
    setDraft(v)
    onCommit(v)
  }
  return multiline ? (
    <textarea id={id} className={cls} rows={rows} value={draft} placeholder={placeholder} onChange={(e) => change(e.target.value)} />
  ) : (
    <input id={id} className={cls} type={type} value={draft} placeholder={placeholder} onChange={(e) => change(e.target.value)} />
  )
}
