import { useState } from 'react';
import { Modal } from './Modal.tsx';

interface Props {
  title: string;
  text: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, text, confirmLabel, cancelLabel, onConfirm, onCancel }: Props) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onCancel}>
      <p>{text}</p>
      <div className="cty-actions">
        <button type="button" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
        <button
          type="button"
          className="cty-danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try { await onConfirm(); } finally { setBusy(false); }
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
