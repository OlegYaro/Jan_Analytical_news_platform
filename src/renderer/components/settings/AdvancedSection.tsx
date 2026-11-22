import { useState } from 'react'
import { STAGE_KEYS } from '../../../shared/types.ts'
import type { StageKey } from '../../../shared/types.ts'
import { ts } from '../../strings-settings.ts'
import { DraftInput } from './DraftInput.tsx'
import { Field, SectionShell } from './Field.tsx'
import { DEFAULT_TIMEOUTS_MIN, parseMinutes } from './logic.ts'
import type { SectionProps } from './SectionProps.ts'
import { useSectionSave } from './useSectionSave.ts'

const s = ts.advanced
const MODELS = ['haiku', 'sonnet', 'opus'] as const

export function AdvancedSection({ settings, onSettings, compact }: SectionProps) {
  const { errors, failed, version, saveNow, saveLater, reset } = useSectionSave(onSettings)
  const adv = settings.advanced
  const [skills, setSkills] = useState<string[] | null>(null)
  const [skillsError, setSkillsError] = useState(false)
  const [skillName, setSkillName] = useState('')
  const [skillText, setSkillText] = useState('')

  const toggleSkills = async () => {
    if (skills) {
      setSkills(null)
      setSkillName('')
      setSkillText('')
      return
    }
    try {
      setSkills(await window.rw.skills.list())
      setSkillsError(false)
    } catch {
      setSkillsError(true)
    }
  }

  const openSkill = async (name: string) => {
    setSkillName(name)
    setSkillText('')
    if (name === '') return
    try {
      setSkillText(await window.rw.skills.read(name))
      setSkillsError(false)
    } catch {
      setSkillsError(true)
    }
  }

  const resetAll = () => void reset('all', [s.resetAllConfirm1, s.resetAllConfirm2])

  return (
    <SectionShell
      id="settings-advanced"
      title={s.title}
      compact={compact}
      failed={failed}
      onReset={() => void reset('advanced', [ts.resetConfirm])}
    >
      <details className="st-details">
        <summary>{s.summary}</summary>
        <div key={version}>
          <p className="muted">{s.intro}</p>

          <Field label={s.models} hint={s.modelsHint} example={s.modelsExample} defaultValue={s.modelsDefault} compact={compact}>
            <div className="st-grid">
              {STAGE_KEYS.map((k: StageKey) => (
                <label key={k} className="st-grid-row">
                  <span>{s.stages[k]}</span>
                  <select
                    className="st-input"
                    value={adv.stageModels[k] ?? ''}
                    onChange={(e) => saveNow({ advanced: { stageModels: { [k]: e.target.value } } })}
                  >
                    <option value="">{s.byMode}</option>
                    {MODELS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </Field>

          <Field label={s.timeouts} hint={s.timeoutsHint} example={s.timeoutsExample} defaultValue={s.timeoutsDefault} compact={compact}>
            <div className="st-grid">
              {STAGE_KEYS.map((k: StageKey) => {
                const err = errors[`advanced.timeoutsMin.${k}`]
                return (
                  <div key={k}>
                    <label className="st-grid-row">
                      <span>{s.stages[k]}</span>
                      <span className="st-inline">
                        <DraftInput
                          type="number"
                          className="st-short"
                          value={String(adv.timeoutsMin[k] ?? DEFAULT_TIMEOUTS_MIN[k])}
                          invalid={!!err}
                          onCommit={(v) =>
                            saveLater(`timeout-${k}`, {
                              advanced: { timeoutsMin: { [k]: parseMinutes(v) ?? (v.trim() === '' ? DEFAULT_TIMEOUTS_MIN[k] : 0) } },
                            })
                          }
                        />
                        {s.minutes}
                      </span>
                    </label>
                    {err && <div className="st-error">{err}</div>}
                  </div>
                )
              })}
            </div>
          </Field>

          <Field
            label={s.firstRun}
            hint={s.firstRunHint}
            example={s.firstRunExample}
            defaultValue={s.firstRunDefault}
            error={errors['advanced.firstRunDays']}
            htmlFor="st-firstrun"
            compact={compact}
          >
            <DraftInput
              id="st-firstrun"
              type="number"
              className="st-short"
              value={String(adv.firstRunDays)}
              invalid={!!errors['advanced.firstRunDays']}
              onCommit={(v) => saveLater('firstRun', { advanced: { firstRunDays: v.trim() === '' ? 0 : Number(v) } })}
            />
          </Field>

          <Field label={s.transcripts} hint={s.transcriptsHint} example={s.transcriptsExample} defaultValue={s.transcriptsDefault} compact={compact}>
            <label className="st-check">
              <input
                type="checkbox"
                checked={adv.saveTranscripts}
                onChange={(e) => saveNow({ advanced: { saveTranscripts: e.target.checked } })}
              />
              {s.transcripts}
            </label>
          </Field>

          <Field
            label={s.claudePath}
            hint={s.claudePathHint}
            example={s.claudePathExample}
            defaultValue={s.claudePathDefault}
            error={errors['advanced.claudePath']}
            htmlFor="st-claudepath"
            compact={compact}
          >
            <DraftInput
              id="st-claudepath"
              value={adv.claudePath}
              placeholder={s.claudePathAuto}
              invalid={!!errors['advanced.claudePath']}
              onCommit={(v) => saveLater('claudePath', { advanced: { claudePath: v.trim() } })}
            />
          </Field>

          <Field label={s.skills} hint={s.skillsHint} compact={compact}>
            <button type="button" onClick={() => void toggleSkills()}>
              {skills ? s.skillsHide : s.skillsShow}
            </button>
            {skillsError && <div className="st-error">{s.skillsError}</div>}
            {skills && (
              <div className="st-skills">
                {skills.length === 0 ? (
                  <div className="muted">{s.skillsEmpty}</div>
                ) : (
                  <select className="st-input" value={skillName} onChange={(e) => void openSkill(e.target.value)}>
                    <option value="">{s.skillsPick}</option>
                    {skills.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                )}
                {skillName && <pre className="st-pre">{skillText}</pre>}
              </div>
            )}
          </Field>

          <Field label={s.resetAll} hint={s.resetAllHint} compact={compact}>
            <button type="button" className="st-danger" onClick={resetAll}>
              {s.resetAll}
            </button>
          </Field>
        </div>
      </details>
    </SectionShell>
  )
}
