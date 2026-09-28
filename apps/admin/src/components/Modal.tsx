import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ru } from '../i18n/ru.js';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement | null): HTMLElement[] {
  return root ? Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
}

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Куда поставить фокус при открытии (по умолчанию — первый интерактивный элемент). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Запретить закрытие (например, пока выполняется запрос). */
  busy?: boolean;
}

/**
 * Модальное окно: role=dialog + aria-modal, фокус внутри окна (Tab зациклен), Escape закрывает,
 * после закрытия фокус возвращается туда, где был. Остальная страница на время окна — inert.
 */
export function Modal({ title, onClose, children, footer, initialFocusRef, busy = false }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = initialFocusRef?.current ?? focusables(dialogRef.current)[0] ?? dialogRef.current;
    target?.focus();
    const appRoot = document.getElementById('root');
    appRoot?.setAttribute('inert', '');
    return () => {
      appRoot?.removeAttribute('inert');
      previous?.focus();
    };
  }, [initialFocusRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!busy) onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables(dialogRef.current);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="modal__header">
          <h2 id={titleId} className="modal__title">
            {title}
          </h2>
          <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} disabled={busy} aria-label={ru.common.close}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
