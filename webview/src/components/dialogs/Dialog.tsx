import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Operation } from '../../../../shared/protocol';
import { t } from '../../i18n';
import { closeDialog, getRpc, previewOp } from '../../store/actions';
import { get } from '../../store/store';
import { RpcError } from '../../rpc/RpcClient';
import { cx } from '../../util/format';
import { Button, IconButton } from '../ui';

// Actions with options are done in a modal dialog inside the webview.
// Every dialog shows a preview of the git commands that will run at the bottom (dryRun of op/run).

export function DialogShell({
  title,
  children,
  onOk,
  okLabel,
  okDisabled,
  danger,
  preview,
  onCancel,
  wide,
  footerExtra,
  cancelLabel,
}: {
  title: string;
  children: ReactNode;
  onOk?: () => void | Promise<void>;
  okLabel?: string;
  okDisabled?: boolean;
  danger?: boolean;
  /** The operation to preview. null shows no preview */
  preview?: Operation | null;
  onCancel?: () => void;
  wide?: boolean;
  footerExtra?: ReactNode;
  cancelLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [running, setRunning] = useState(false);
  const cancel = onCancel ?? closeDialog;

  useEffect(() => {
    // Focus the first input. If there is none, the OK button; for dangerous actions and dialogs without an OK button, the Cancel button.
    // Always keep focus inside the dialog so it can be closed with Esc (danger looks only at the value when opened)
    const root = ref.current;
    const el =
      root?.querySelector<HTMLElement>(`input:not([type=checkbox]):not([disabled]), textarea, select${danger ? '' : ', button.primary:not(:disabled)'}`) ??
      root?.querySelector<HTMLElement>('button.dialog-cancel');
    el?.focus();
  }, []);

  const ok = async () => {
    if (!onOk || okDisabled || running) return;
    setRunning(true);
    try {
      await onOk();
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div
        ref={ref}
        className={cx('dialog', wide && 'wide')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            cancel();
          } else if (e.key === 'Enter' && !danger && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLSelectElement)) {
            e.preventDefault();
            void ok();
          }
        }}
      >
        <div className="dialog-title">
          <span>{title}</span>
          <IconButton icon="close" title={t('close')} onClick={cancel} />
        </div>
        <div className="dialog-body">{children}</div>
        {preview !== undefined && <CommandPreview op={preview} />}
        <div className="dialog-foot">
          {footerExtra}
          <span className="spacer" />
          <Button className="dialog-cancel" onClick={cancel}>
            {cancelLabel ?? t('cancel')}
          </Button>
          {onOk && (
            <Button primary={!danger} danger={danger} disabled={okDisabled || running} onClick={() => void ok()}>
              {okLabel ?? t('ok')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function CommandPreview({ op }: { op: Operation | null }) {
  const [commands, setCommands] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const key = op ? JSON.stringify(op) : '';
  useEffect(() => {
    if (!op) {
      setCommands([]);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      previewOp(op, ctrl.signal).then(
        (c) => {
          setCommands(c);
          setError(null);
        },
        (e) => {
          if (e instanceof RpcError && e.category === 'cancelled') return;
          setCommands([]);
          setError(e instanceof Error ? e.message : String(e));
        },
      );
    }, 120);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <div className="cmd-preview" aria-label={t('dialog.preview')}>
      <div className="cmd-label">{t('dialog.preview')}</div>
      {error ? <div className="cmd-error">{error}</div> : <pre>{commands.join('\n') || ' '}</pre>}
    </div>
  );
}

export function Field({ label, children, hint, error }: { label: ReactNode; children: ReactNode; hint?: ReactNode; error?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-control">
        {children}
        {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
      </span>
    </label>
  );
}

export function Warning({ children, danger }: { children: ReactNode; danger?: boolean }) {
  return <div className={cx('warning', danger && 'danger')}>{children}</div>;
}

/** Validate with git check-ref-format while typing */
export function useRefNameValidation(name: string, existing: string[]): { valid: boolean; message?: string } {
  const [state, setState] = useState<{ valid: boolean; message?: string }>({ valid: false });
  // Compare by contents, not by array identity (so re-validation does not keep running when the caller recreates it every time)
  const existingKey = existing.join('\n');
  useEffect(() => {
    const n = name.trim();
    if (!n) {
      setState({ valid: false });
      return;
    }
    if (existing.includes(n)) {
      setState({ valid: false, message: t('dialog.nameExists') });
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      getRpc()
        .request('ref/validate', { repo: get().boot.repo, name: n }, ctrl.signal)
        .then(
          (r) => setState(r.valid ? { valid: true } : { valid: false, message: t('dialog.nameInvalid') }),
          () => undefined,
        );
    }, 150);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, existingKey]);
  return state;
}
