import { useState } from 'react';
import { th } from '../../strings-history.ts';

/** «Открыть папку в Finder» с показом ошибки. */
export function FolderButton({ runId, code }: { runId: string; code?: string }) {
  const [error, setError] = useState('');
  async function open() {
    setError('');
    try {
      const r = await window.rw.history.openFolder(runId, code);
      if (!r.ok) setError(th.openFolderError(r.error ?? ''));
    } catch (e) {
      setError(th.openFolderError(String((e as Error)?.message ?? e)));
    }
  }
  return (
    <>
      <button type="button" onClick={open}>{th.openFolder}</button>
      {error && <span className="error" role="alert">{error}</span>}
    </>
  );
}
