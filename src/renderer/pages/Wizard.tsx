import { useCallback, useEffect, useState } from 'react';
import type { DoctorCheck } from '../../shared/doctor-types.ts';
import type { Settings } from '../../shared/types.ts';
import { FoldersSection } from '../components/settings/FoldersSection.tsx';
import { MailSection } from '../components/settings/MailSection.tsx';
import { ScheduleSection } from '../components/settings/ScheduleSection.tsx';
import { SearchSection } from '../components/settings/SearchSection.tsx';
import { SaveStatusProvider } from '../components/settings/useSaveStatus.ts';
import { StepComputer } from '../components/wizard/StepComputer.tsx';
import { StepCountries } from '../components/wizard/StepCountries.tsx';
import { StepDone } from '../components/wizard/StepDone.tsx';
import { StepSources } from '../components/wizard/StepSources.tsx';
import { STEP_COUNT, canProceed } from '../components/wizard/logic.ts';
import { t } from '../strings.ts';
import '../styles-settings.css';
import '../styles-wizard.css';
import '../styles-sources.css';

interface Props {
  settings: Settings;
  onSettings: (s: Settings) => void;
}

export function Wizard({ settings, onSettings }: Props) {
  const [step, setStep] = useState(1);
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState(false);

  const recheck = useCallback(async () => {
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
    void recheck();
  }, [recheck]);

  const ok = canProceed(step, { doctor: checks, mailVerified: settings.mail.verified === true });
  const last = step === STEP_COUNT;

  const finish = async () => {
    setFinishing(true);
    setFinishError(false);
    try {
      await window.rw.app.completeOnboarding();
      onSettings(await window.rw.settings.get());
    } catch {
      setFinishError(true);
      setFinishing(false);
    }
  };

  const p = { settings, onSettings, compact: true };
  let body;
  switch (step) {
    case 1: body = <StepComputer checks={checks} running={running} failed={failed} onRecheck={() => void recheck()} />; break;
    case 2: body = <FoldersSection {...p} />; break;
    case 3: body = <MailSection {...p} />; break;
    case 4: body = <SearchSection {...p} />; break;
    case 5: body = <StepCountries />; break;
    case 6: body = <ScheduleSection {...p} />; break;
    case 7: body = <StepSources />; break;
    default: body = <StepDone settings={settings} />;
  }

  return (
    <div className="wz">
      <div className="wz-inner">
        <h1>{t.wizard.title}</h1>
        <ol className="wz-steps" aria-label={t.wizard.stepOf(step, STEP_COUNT)}>
          {t.wizard.steps.map((name, i) => (
            <li key={name} className={i + 1 === step ? 'cur' : i + 1 < step ? 'done' : ''} aria-current={i + 1 === step ? 'step' : undefined}>
              <span className="wz-dot">{i + 1 < step ? '✓' : i + 1}</span>
              <span className="wz-name">{name}</span>
            </li>
          ))}
        </ol>
        <p className="muted">{t.wizard.stepOf(step, STEP_COUNT)}: {t.wizard.steps[step - 1]}</p>
        <SaveStatusProvider>{body}</SaveStatusProvider>
        {finishError && <p className="error">{t.wizard.finishError}</p>}
        <div className="wz-nav">
          <button type="button" onClick={() => setStep(step - 1)} disabled={step === 1 || finishing}>{t.wizard.back}</button>
          {last ? (
            <button type="button" className="wz-primary" onClick={() => void finish()} disabled={finishing}>{t.wizard.finish}</button>
          ) : (
            <button type="button" className="wz-primary" onClick={() => setStep(step + 1)} disabled={!ok}>{t.wizard.next}</button>
          )}
        </div>
        {!ok && step === 3 && <p className="wz-hint">{t.wizard.mailBlocked}</p>}
        {!ok && step === 1 && !running && checks && <p className="wz-hint">{t.wizard.doctorBlocked}</p>}
      </div>
    </div>
  );
}
