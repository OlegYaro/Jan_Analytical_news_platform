import { useCallback, useEffect, useState } from 'react';
import type { DoctorCheck } from '../../shared/doctor-types.ts';
import type { GateStatus } from '../../shared/api.ts';
import type { RunStartMode, RunStartOptions, RunStatusDto } from '../../shared/run-types.ts';
import type { Country, Settings } from '../../shared/types.ts';
import type { PageId } from '../App.tsx';
import { DoctorTable } from '../components/DoctorTable.tsx';
import { Modal } from '../components/countries/Modal.tsx';
import { RunPanel } from '../components/RunPanel.tsx';
import { homeWarnings } from '../components/home/logic.ts';
import { th } from '../strings-home.ts';
import { estimateText, pauseText, validatePeriod } from '../components/run/logic.ts';
import { useRunStatus } from '../components/run/useRunStatus.ts';
import { nearestRunText } from '../components/settings/logic.ts';
import { useKnownCountries } from '../components/settings/useCountryNames.ts';
import { ts as tss } from '../strings-settings.ts';
import { t } from '../strings.ts';
import { tr } from '../strings-run.ts';
import '../styles-wizard.css';
import '../styles-run.css';

interface Props {
  settings: Settings | null;
  gate: GateStatus | null;
  goTo: (p: PageId) => void;
}

const tsc = tss.schedule;

function EstimateLine({ e }: { e: NonNullable<RunStatusDto['estimate']> }) {
  const x = estimateText(e);
  return (
    <>
      <p className="home-status muted">{x.rough ? `${x.line} (${x.rough})` : x.line}</p>
      {x.over && <p className="run-pause">{x.over}</p>}
    </>
  );
}

export function Home({ settings, gate, goTo }: Props) {
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const { status, error: pollError, refresh } = useRunStatus();
  const [starting, setStarting] = useState(false);
  const [startMsg, setStartMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [periodError, setPeriodError] = useState('');
  const [countries, setCountries] = useState<Country[] | null>(null);

  useEffect(() => {
    window.rw.countries.list().then(setCountries).catch(() => setCountries(null));
  }, [status?.run?.id, status?.running]);

  const run = useCallback(async () => {
    setRunning(true);
    setFailed(false);
    try {
      setChecks(await window.rw.doctor.run());
    } catch {
      setFailed(true);
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  const start = async (mode: RunStartMode, opts?: RunStartOptions): Promise<boolean> => {
    setStarting(true);
    setStartMsg(null);
    try {
      const r = await window.rw.run.start(mode, opts);
      setStartMsg({ ok: r.ok, text: r.message });
      refresh();
      return r.ok;
    } catch {
      setStartMsg({ ok: false, text: tr.startFailed });
      return false;
    } finally {
      setStarting(false);
    }
  };

  const submitPeriod = async () => {
    const w = validatePeriod(from, to);
    if (!w) {
      setPeriodError(tr.period.bad);
      return;
    }
    setPeriodError('');
    setPeriodOpen(false);
    await start('backfill', { window: w });
  };

  const now = new Date();
  const known = useKnownCountries();
  const next = settings ? nearestRunText(settings.schedules, now, known, { countries: tsc.countriesWord, all: tsc.countriesAll }) : null;
  const canStart = !!status?.canStart && !starting;
  const canDry = !!status?.canDryRun && !starting;
  const blocked = status?.startBlockedReason ?? '';

  let statusLine: string | null = null;
  if (status?.running) {
    statusLine = status.paused && status.pausedUntil ? pauseText(status.pausedUntil, now) : tr.runningNow(status.current?.text ?? '…');
  } else if (settings) {
    statusLine = !settings.mail.verified ? t.home.scheduleOff : next ? t.home.nextRun(next) : t.home.scheduleEmpty;
  }

  return (
    <>
      <h1>{t.extra.homeTitle}</h1>
      {gate && !gate.canRun && (
        <div className="banner warn">
          <span>{gate.message || t.mailBanner.text}</span>
          <button type="button" className="link" onClick={() => goTo('settings')}>
            {t.home.setupMail}
          </button>
        </div>
      )}
      {statusLine && <p className="home-status">{statusLine}</p>}
      {homeWarnings(countries, status, now).map((w) => (
        <div key={w.kind} className="banner warn" role="alert">
          <span>{w.text}</span>
          {w.linkToCountries && (
            <button type="button" className="link" onClick={() => goTo('countries')}>
              {th.openCountries}
            </button>
          )}
        </div>
      ))}
      {status?.notice && <p className="home-status muted">{status.notice}</p>}
      <div className="home-actions">
        <button type="button" disabled={!canStart} title={canStart ? undefined : blocked} onClick={() => void start('manual')}>
          {t.home.checkNow}
        </button>
        <button type="button" disabled={!canDry} onClick={() => void start('dry_run')}>
          {t.home.dryRun}
        </button>
        <button type="button" disabled={!canStart} title={canStart ? undefined : blocked} onClick={() => setPeriodOpen(true)}>
          {t.home.checkPeriod}
        </button>
      </div>
      {status?.estimate && !status.running && <EstimateLine e={status.estimate} />}
      {startMsg && <p className={startMsg.ok ? 'run-actions-msg' : 'run-actions-msg error'}>{startMsg.text}</p>}
      <RunPanel status={status} pollError={pollError} onChanged={refresh} />
      <section className="card">
        <div className="card-head">
          <h2>{t.doctor.title}</h2>
          <button type="button" onClick={() => void run()} disabled={running}>
            {t.doctor.recheck}
          </button>
        </div>
        {running && <p className="muted">{t.extra.doctorChecking}</p>}
        {failed && <p className="error">{t.extra.doctorError}</p>}
        {!running && checks && <DoctorTable checks={checks} />}
      </section>
      {periodOpen && (
        <Modal title={tr.period.title} onClose={() => setPeriodOpen(false)}>
          <p className="muted">{tr.period.hint}</p>
          <div className="run-period">
            <label>
              {tr.period.from} <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>
              {tr.period.to} <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
          {periodError && <p className="error">{periodError}</p>}
          <div className="cty-actions">
            <button type="button" onClick={() => setPeriodOpen(false)}>{tr.period.cancel}</button>
            <button type="button" onClick={() => void submitPeriod()}>{tr.period.go}</button>
          </div>
        </Modal>
      )}
    </>
  );
}
