import { useEffect, useState } from 'react'
import type { MailSecurity, MailService, ReportLanguage } from '../../../shared/types.ts'
import { MAIL_HELP_LINKS } from '../../../shared/mail-links.ts'
import { ts } from '../../strings-settings.ts'
import { DraftInput } from './DraftInput.tsx'
import { Field, SectionShell } from './Field.tsx'
import { effectiveRecipients, formatRecipients } from './logic.ts'
import type { SectionProps } from './SectionProps.ts'
import { useSaveStatus } from './useSaveStatus.ts'
import { useSectionSave } from './useSectionSave.ts'

const s = ts.mail
const SERVICES: readonly { id: MailService; label: string }[] = [
  { id: 'gmail', label: 'Gmail' },
  { id: 'outlook', label: 'Outlook' },
  { id: 'icloud', label: 'iCloud' },
  { id: 'yandex', label: s.serviceYandex },
  { id: 'mailru', label: 'Mail.ru' },
  { id: 'other', label: s.serviceOther },
]
const LANGS: readonly ReportLanguage[] = ['ru', 'en', 'both_one', 'both_two']
const SECURITIES: readonly MailSecurity[] = ['ssl', 'starttls', 'none']

export function MailSection({ settings, onSettings, compact }: SectionProps) {
  const { errors, failed, version, saveNow, saveLater, reset } = useSectionSave(onSettings)
  const { markSaved } = useSaveStatus()
  const mail = settings.mail
  const [pwSet, setPwSet] = useState<boolean | null>(null)
  const [pw, setPw] = useState('')
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [sending, setSending] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null)

  const loadStatus = () => {
    window.rw.secrets.status().then((r) => setPwSet(r.mailPasswordSet)).catch(() => setPwSet(null))
  }
  useEffect(loadStatus, [])

  const savePassword = async () => {
    if (pw === '') return
    try {
      await window.rw.secrets.setMailPassword(pw)
      setPw('')
      setPwMsg({ ok: true, text: s.passwordSaved })
      loadStatus()
      markSaved()
      onSettings(await window.rw.settings.get())
    } catch {
      setPwMsg({ ok: false, text: s.passwordError })
    }
  }

  const sendTest = async () => {
    setSending(true)
    setTest(null)
    try {
      const r = await window.rw.mail.sendTest()
      setTest({ ok: r.ok, text: r.ok ? s.testOk : r.message || s.testFail })
    } catch {
      setTest({ ok: false, text: s.testError })
    }
    try {
      onSettings(await window.rw.settings.get())
    } catch {
      /* настройки обновятся при следующем открытии */
    }
    setSending(false)
  }

  const help = MAIL_HELP_LINKS[mail.service]
  const isOther = mail.service === 'other'

  return (
    <SectionShell
      id="settings-mail"
      title={s.title}
      compact={compact}
      failed={failed}
      onReset={() => void reset('mail', [ts.resetConfirm])}
    >
      <div key={version}>
        <Field label={s.service} hint={s.serviceHint} example={s.serviceExample} defaultValue={s.serviceDefault} error={errors['mail.service']} htmlFor="st-service" compact={compact}>
          <select
            id="st-service"
            className="st-input st-short"
            value={mail.service}
            onChange={(e) => saveNow({ mail: { service: e.target.value as MailService } })}
          >
            {SERVICES.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label={s.address} hint={s.addressHint} example={s.addressExample} defaultValue={s.addressDefault} error={errors['mail.address']} htmlFor="st-address" compact={compact}>
          <DraftInput
            id="st-address"
            type="email"
            value={mail.address}
            invalid={!!errors['mail.address']}
            onCommit={(v) => saveLater('address', { mail: { address: v.trim() } })}
          />
        </Field>

        <Field
          label={s.password}
          hint={help ? undefined : s.passwordHint}
          example={s.passwordExample}
          defaultValue={s.passwordDefault}
          error={pwMsg && !pwMsg.ok ? pwMsg.text : undefined}
          htmlFor="st-password"
          compact={compact}
        >
          <div className="st-inline">
            <input
              id="st-password"
              className="st-input"
              type="password"
              autoComplete="off"
              value={pw}
              placeholder={pwSet ? s.passwordChange : ''}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void savePassword()
              }}
              onBlur={() => void savePassword()}
            />
            <button type="button" disabled={pw === ''} onClick={() => void savePassword()}>
              {s.passwordSave}
            </button>
          </div>
          <div className="st-hint">
            {s.passwordStatus}: <strong>{pwSet === null ? '…' : pwSet ? s.passwordSet : s.passwordNotSet}</strong>
            {pwMsg?.ok && <span> · {pwMsg.text}</span>}
          </div>
          {help && (
            <div className="st-hint">
              {s.passwordHint}.{' '}
              <a href={help} target="_blank" rel="noreferrer">
                {s.passwordHowTo}
              </a>
            </div>
          )}
        </Field>

        <Field
          label={s.recipients}
          hint={s.recipientsHint}
          example={s.recipientsExample}
          defaultValue={s.recipientsDefault}
          error={errors['mail.recipients']}
          htmlFor="st-recipients"
          compact={compact}
        >
          <DraftInput
            id="st-recipients"
            value={formatRecipients(mail.recipients)}
            invalid={!!errors['mail.recipients']}
            onCommit={(v) => saveLater('recipients', { mail: { recipients: effectiveRecipients(v, mail.address) } })}
          />
        </Field>

        <Field label={s.language} hint={s.languageHint} example={s.languageExample} defaultValue={s.languageDefault} error={errors.reportLanguage} htmlFor="st-lang" compact={compact}>
          <select
            id="st-lang"
            className="st-input st-short"
            value={settings.reportLanguage}
            onChange={(e) => saveNow({ reportLanguage: e.target.value as ReportLanguage })}
          >
            {LANGS.map((l) => (
              <option key={l} value={l}>
                {s.languages[l]}
              </option>
            ))}
          </select>
        </Field>

        <Field label={s.alerts} hint={s.alertsHint} example={s.alertsExample} defaultValue={s.alertsDefault} error={errors.failureAlerts} compact={compact}>
          <label className="st-check">
            <input type="checkbox" checked={settings.failureAlerts} onChange={(e) => saveNow({ failureAlerts: e.target.checked })} />
            {s.alerts}
          </label>
        </Field>

        {isOther && (
          <>
            <Field label={s.server} hint={s.serverHint} example={s.serverExample} defaultValue={s.serverDefault} error={errors['mail.server']} htmlFor="st-server" compact={compact}>
              <DraftInput
                id="st-server"
                value={mail.server}
                invalid={!!errors['mail.server']}
                onCommit={(v) => saveLater('server', { mail: { server: v.trim() } })}
              />
            </Field>
            <Field label={s.port} hint={s.portHint} example={s.portExample} defaultValue={s.portDefault} error={errors['mail.port']} htmlFor="st-port" compact={compact}>
              <DraftInput
                id="st-port"
                type="number"
                className="st-short"
                value={String(mail.port)}
                invalid={!!errors['mail.port']}
                onCommit={(v) => saveLater('port', { mail: { port: v.trim() === '' ? 0 : Number(v) } })}
              />
            </Field>
            <Field label={s.security} hint={s.securityHint} example={s.securityExample} defaultValue={s.securityDefault} error={errors['mail.security']} htmlFor="st-security" compact={compact}>
              <select
                id="st-security"
                className="st-input st-short"
                value={mail.security}
                onChange={(e) => saveNow({ mail: { security: e.target.value as MailSecurity } })}
              >
                {SECURITIES.map((o) => (
                  <option key={o} value={o}>
                    {s.securities[o]}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}

        <div className="st-mail-test">
          <div className="st-inline">
            <button type="button" disabled={sending} onClick={() => void sendTest()}>
              {sending ? s.sending : s.sendTest}
            </button>
            <strong className={mail.verified ? 'st-ok' : 'st-warn'}>{mail.verified ? s.verified : s.notVerified}</strong>
          </div>
          {test && <div className={test.ok ? 'st-ok' : 'st-error'}>{test.text}</div>}
          {!mail.verified && <div className="st-hint">{s.gateHint}</div>}
        </div>
      </div>
    </SectionShell>
  )
}
