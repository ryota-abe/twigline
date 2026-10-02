import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../util/format';

/** Icon from @vscode/codicons */
export function Icon({ name, className, title, spin }: { name: string; className?: string; title?: string; spin?: boolean }) {
  return <i className={cx('codicon', `codicon-${name}`, spin && 'codicon-modifier-spin', className)} title={title} aria-hidden={title ? undefined : true} />;
}

export function Button({
  primary,
  danger,
  small,
  icon,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; danger?: boolean; small?: boolean; icon?: string }) {
  return (
    <button type="button" className={cx('btn', primary && 'primary', danger && 'danger', small && 'small', className)} {...rest}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

export function IconButton({ icon, title, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; title: string }) {
  return (
    <button type="button" className={cx('icon-btn', className)} title={title} aria-label={title} {...rest}>
      <Icon name={icon} />
    </button>
  );
}

/**
 * A button that opens a small popup. Used to tuck away rarely used settings.
 * Closes when pressing outside the popup or Esc (opening a select inside does not count as the mouse leaving)
 */
export function MenuButton({
  icon,
  title,
  label,
  dot,
  align = 'left',
  direction = 'up',
  menu,
  children,
}: {
  icon: string;
  title: string;
  /** Short text shown beside the icon (such as the current filter) */
  label?: string;
  /** A dot showing that some item differs from the default */
  dot?: boolean;
  align?: 'left' | 'right';
  direction?: 'up' | 'down';
  /** Contents are a list of MenuItem. On open, focus moves to the first item; ↑ ↓ Home End move between items */
  menu?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    if (menu) buttonRef.current?.focus();
  }, [menu]);
  useEffect(() => {
    if (!open) return;
    if (menu) popupRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, menu, close]);
  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(popupRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else return;
    e.preventDefault();
    items[next]?.focus();
  };
  return (
    <span className="menu-anchor" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className={cx('icon-btn', 'menu-btn', open && 'on')}
        title={title}
        aria-label={title}
        aria-haspopup={menu ? 'menu' : 'true'}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name={icon} />
        {label && <span className="menu-btn-label">{label}</span>}
        {dot && <span className="dot" />}
      </button>
      {open && (
        <div
          ref={popupRef}
          className={cx('popup', menu && 'menu', align === 'right' && 'right', direction === 'down' && 'down')}
          role={menu ? 'menu' : 'dialog'}
          aria-label={title}
          onKeyDown={menu ? onMenuKey : undefined}
        >
          {children(close)}
        </div>
      )}
    </span>
  );
}

/** Item of a MenuButton (menu) */
export function MenuItem({ label, hint, disabled, onSelect }: { label: string; hint?: string; disabled?: boolean; onSelect: () => void }) {
  return (
    <button type="button" role="menuitem" className="popup-item menu-item" disabled={disabled} onClick={onSelect}>
      <span className="ellipsis">{label}</span>
      {hint && <span className="menu-hint">{hint}</span>}
    </button>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label className={cx('check', disabled && 'disabled')} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-vscode-context='{"preventDefaultContextMenuItems":false}' />
      <span>{label}</span>
    </label>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  title,
  className,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  title?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <select className={cx('select', className)} value={value} title={title} aria-label={title} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Handle that changes a split position. Moves left/right when direction is row, up/down when column */
export function Splitter({
  direction,
  value,
  onChange,
  min,
  max,
  invert,
}: {
  direction: 'row' | 'column';
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  /** When the handle is before the target (above / left), resize in the direction opposite to the movement */
  invert?: boolean;
}) {
  const start = useRef<{ pos: number; value: number } | null>(null);
  const onMove = useCallback(
    (e: PointerEvent) => {
      if (!start.current) return;
      const pos = direction === 'row' ? e.clientX : e.clientY;
      const delta = (pos - start.current.pos) * (invert ? -1 : 1);
      onChange(Math.min(max, Math.max(min, start.current.value + delta)));
    },
    [direction, invert, max, min, onChange],
  );
  const onUp = useCallback(() => {
    start.current = null;
    document.body.classList.remove('resizing-row', 'resizing-column');
  }, []);
  useEffect(() => {
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [onMove, onUp]);
  return (
    <div
      className={cx('splitter', direction)}
      role="separator"
      aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'}
      onPointerDown={(e) => {
        e.preventDefault();
        start.current = { pos: direction === 'row' ? e.clientX : e.clientY, value };
        document.body.classList.add(direction === 'row' ? 'resizing-row' : 'resizing-column');
      }}
    />
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return <Icon name="loading" spin className={cx('spinner', small && 'small')} />;
}

export function Empty({ children, icon }: { children: ReactNode; icon?: string }) {
  return (
    <div className="empty">
      {icon && <Icon name={icon} />}
      <div>{children}</div>
    </div>
  );
}

/** Value of the data-vscode-context attribute */
export function vsContext(section: string, data: Record<string, unknown>): string {
  return JSON.stringify({ webviewSection: section, preventDefaultContextMenuItems: true, ...data });
}
