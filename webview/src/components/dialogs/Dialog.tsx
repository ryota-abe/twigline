import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Operation, RefComparison, RefInfo } from '../../../../shared/protocol';
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

/**
 * Something that must be settled before OK is enabled (a force push, stashing local changes...): a warning with a title,
 * what happens, and the controls that settle it (an option to check, buttons for another way). The dialog keeps OK disabled until then
 */
export function Requirement({ title, detail, danger, children }: { title: ReactNode; detail?: ReactNode; danger?: boolean; children?: ReactNode }) {
  return (
    <Warning danger={danger}>
      <div className="requirement">
        <strong>{title}</strong>
        {detail && <span>{detail}</span>}
        {children}
      </div>
    </Warning>
  );
}

/** Buttons offering another way, under a Requirement */
export function RequirementActions({ children }: { children: ReactNode }) {
  return <div className="row wrap">{children}</div>;
}

/** Options that are rarely changed, collapsed under "Details" */
export function Advanced({ children }: { children: ReactNode }) {
  return (
    <details className="dialog-advanced">
      <summary>{t('dialog.advanced')}</summary>
      <div className="dialog-advanced-body">{children}</div>
    </details>
  );
}

type CompareOpts = { files?: boolean; conflicts?: boolean };

/** Key of one comparison in the map useRefCompares returns */
export function compareKey(ours: string, theirs: string): string {
  return `${ours}..${theirs}`;
}

/**
 * Compare pairs of commits on the host (ahead / behind, merge base, and optionally incoming files and predicted conflicts).
 * Pass SHAs so a moved ref is compared again. The map (by compareKey) has no entry while loading, null when a side does not resolve.
 * Results are kept for the life of the dialog, so a pair is asked for once (opts must therefore stay the same for that time)
 */
export function useRefCompares(pairs: readonly (readonly [string, string])[], opts: CompareOpts = {}): ReadonlyMap<string, RefComparison | null> {
  const [results, setResults] = useState<ReadonlyMap<string, RefComparison | null>>(new Map());
  const missing = [...new Set(pairs.map(([a, b]) => compareKey(a, b)))].filter((k) => !results.has(k));
  const key = missing.length > 0 ? JSON.stringify([missing, !!opts.files, !!opts.conflicts]) : '';
  useEffect(() => {
    if (!key) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      const repo = get().boot.repo;
      void Promise.all(
        missing.map(async (k): Promise<[string, RefComparison | null] | undefined> => {
          const [ours, theirs] = k.split('..');
          try {
            return [k, await getRpc().request('ref/compare', { repo, ours, theirs, files: opts.files, conflicts: opts.conflicts }, ctrl.signal)];
          } catch (e) {
            // Treated like "not known": the dialog still works without the comparison
            return e instanceof RpcError && e.category === 'cancelled' ? undefined : [k, null];
          }
        }),
      ).then((entries) => {
        if (ctrl.signal.aborted) return;
        setResults((prev) => new Map([...prev, ...entries.filter((e) => e !== undefined)]));
      });
    }, 100);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return results;
}

/** useRefCompares for one pair. undefined while loading (and when a side is not given), null when a side does not resolve */
export function useRefCompare(ours: string | undefined, theirs: string | undefined, opts: CompareOpts = {}): RefComparison | null | undefined {
  const results = useRefCompares(ours && theirs ? [[ours, theirs]] : [], opts);
  return ours && theirs ? results.get(compareKey(ours, theirs)) : undefined;
}

/**
 * The result of a request made while a dialog is open, asked again when key changes (debounced; a request in flight is cancelled).
 * An empty key asks for nothing. undefined while loading, null when it failed
 */
export function useRequest<T>(key: string, run: (signal: AbortSignal) => Promise<T>): T | null | undefined {
  const [state, setState] = useState<{ key: string; value: T | null } | null>(null);
  useEffect(() => {
    if (!key) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      run(ctrl.signal).then(
        (value) => setState({ key, value }),
        // Treated like "not known": the dialog still works without it
        (e) => !(e instanceof RpcError && e.category === 'cancelled') && setState({ key, value: null }),
      );
    }, 100);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state && state.key === key ? state.value : undefined;
}

/**
 * ahead / behind of local refs against one base commit, in one request (ahead: commits only the ref has), keyed by full ref name.
 * Asked again when the base or a ref moves. undefined while loading, null when it could not be counted
 */
export function useAheadBehind(base: string | undefined, refs: readonly RefInfo[]): Record<string, { ahead: number; behind: number }> | null | undefined {
  const key = base && refs.length > 0 ? JSON.stringify([base, refs.map((r) => [r.fullName, r.sha])]) : '';
  const value = useRequest(key, (signal) => getRpc().request('ref/aheadBehind', { repo: get().boot.repo, base: base!, refs: refs.map((r) => r.fullName) }, signal));
  return key ? value : refs.length === 0 ? {} : undefined;
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
