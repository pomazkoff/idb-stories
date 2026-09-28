import { useRef, type ReactNode } from 'react';
import { ru } from '../i18n/ru.js';
import { ErrorMessage } from './ErrorMessage.js';
import { Modal } from './Modal.js';

export interface ConfirmDialogProps {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
  error?: unknown;
  danger?: boolean;
  confirmDisabled?: boolean;
  onReload?: () => void;
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  pending = false,
  error,
  danger = false,
  confirmDisabled = false,
  onReload,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      title={title}
      onClose={onCancel}
      busy={pending}
      initialFocusRef={cancelRef}
      footer={
        <>
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel} disabled={pending}>
            {ru.common.cancel}
          </button>
          <button
            type="button"
            className={danger ? 'btn btn--danger' : 'btn btn--primary'}
            onClick={onConfirm}
            disabled={pending || confirmDisabled}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
      <ErrorMessage error={error} onReload={onReload} />
    </Modal>
  );
}
