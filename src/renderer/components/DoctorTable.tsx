import type { DoctorCheck } from '../../shared/doctor-types.ts';
import { t } from '../strings.ts';

export function DoctorTable({ checks }: { checks: DoctorCheck[] }) {
  return (
    <table className="doctor">
      <tbody>
        {checks.map((c) => (
          <tr key={c.id} className={c.ok ? 'ok' : 'bad'}>
            <td className="mark">{c.ok ? '✅' : '❌'}</td>
            <td>
              <div className="check-title">{c.title || t.doctor.checks[c.id]}</div>
              {c.detail && <div className="muted">{c.detail}</div>}
              {!c.ok && c.fix && (
                <div className="fix">
                  <strong>{t.extra.doctorFix}:</strong> {c.fix}
                  {c.link && (
                    <>
                      {' '}
                      <a href={c.link} target="_blank" rel="noreferrer">
                        {t.extra.doctorLink}
                      </a>
                    </>
                  )}
                </div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
