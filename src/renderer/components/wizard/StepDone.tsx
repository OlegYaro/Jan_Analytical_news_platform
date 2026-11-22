import { useState } from 'react';
import type { Settings } from '../../../shared/types.ts';
import { t } from '../../strings.ts';
import { ts } from '../../strings-sources.ts';
import { useRunStatus } from '../run/useRunStatus.ts';
import { nearestRunText } from '../settings/logic.ts';
import { useKnownCountries } from '../settings/useCountryNames.ts';
import { ts as tss } from '../../strings-settings.ts';

const tsc = tss.schedule;

export function StepDone({ settings }: { settings: Settings }) {
  const now = new Date();
  const known = useKnownCountries();
  const next = nearestRunText(settings.schedules, now, known, { countries: tsc.countriesWord, all: tsc.countriesAll });
  const { status, refresh } = useRunStatus();
  const [starting, setStarting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const canDry = !!status?.canDryRun && !starting;

  const start = async () => {
    setStarting(true);
    setMsg(null);
    try {
      const r = await window.rw.run.start('dry_run');
      setMsg({ ok: r.ok, text: r.ok ? ts.dry.started : r.message });
      refresh();
    } catch {
      setMsg({ ok: false, text: ts.dry.failed });
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="card">
      <h2>{t.wizard.doneTitle}</h2>
      <p className="wz-next">{next ? t.wizard.doneNext(next) : t.wizard.doneNoSchedule}</p>
      <button type="button" disabled={!canDry} title={canDry ? undefined : status?.startBlockedReason || undefined} onClick={() => void start()}>{t.wizard.dryRun}</button>
      <p className="muted">{ts.dry.hint}</p>
      {msg && <p className={msg.ok ? undefined : 'error'}>{msg.text}</p>}
    </section>
  );
}
