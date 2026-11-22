import { DEFAULT_PERSPECTIVE, DEFAULT_TOPIC } from '../../../shared/types.ts'
import { ts } from '../../strings-settings.ts'
import { DraftInput } from './DraftInput.tsx'
import { Field, SectionShell } from './Field.tsx'
import type { SectionProps } from './SectionProps.ts'
import { useSectionSave } from './useSectionSave.ts'

const s = ts.search
const same = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()

export function SearchSection({ settings, onSettings, compact }: SectionProps) {
  const { errors, failed, version, saveNow, saveLater, reset } = useSectionSave(onSettings)
  return (
    <SectionShell
      id="settings-search"
      title={s.title}
      compact={compact}
      failed={failed}
      onReset={() => void reset('search', [ts.resetConfirm])}
    >
      <div key={version}>
        <Field
          label={s.topic}
          hint={s.topicHint}
          example={s.topicExample}
          defaultValue={s.topicDefault}
          error={errors.topic}
          htmlFor="st-topic"
          compact={compact}
        >
          <DraftInput
            id="st-topic"
            multiline
            rows={12}
            value={settings.topic}
            invalid={!!errors.topic}
            onCommit={(v) => saveLater('topic', { topic: v })}
          />
        </Field>
        {s.topicRu !== '' && same(settings.topic, DEFAULT_TOPIC) && <div className="st-hint st-caption">{s.topicRu}</div>}

        <Field
          label={s.perspective}
          hint={s.perspectiveHint}
          example={s.perspectiveExample}
          defaultValue={s.perspectiveDefault}
          error={errors.perspective}
          htmlFor="st-perspective"
          compact={compact}
        >
          <DraftInput
            id="st-perspective"
            multiline
            rows={4}
            value={settings.perspective}
            invalid={!!errors.perspective}
            onCommit={(v) => saveLater('perspective', { perspective: v })}
          />
        </Field>
        {s.perspectiveRu !== '' && same(settings.perspective, DEFAULT_PERSPECTIVE) && <div className="st-hint st-caption">{s.perspectiveRu}</div>}

        <Field
          label={s.news}
          hint={s.newsHint}
          example={s.newsExample}
          defaultValue={s.newsDefault}
          error={errors.newsEnabled}
          compact={compact}
        >
          <label className="st-check">
            <input type="checkbox" checked={settings.newsEnabled} onChange={(e) => saveNow({ newsEnabled: e.target.checked })} />
            {s.news}
          </label>
        </Field>
      </div>
    </SectionShell>
  )
}
