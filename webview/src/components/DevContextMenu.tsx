import { useEffect, useState } from 'react';
import { handleCommand } from '../commands';

// Right-click menu used only by the development server (browser).
// In VS Code the native webview/context menu appears, so this is not shown.
// It evaluates the when clauses of package.json in a simple way and runs the same commands inside the webview.

interface MenuItem {
  command: string;
  when: string;
  group: string;
  title: string;
}

export function evalWhen(when: string, ctx: Record<string, unknown>): boolean {
  return when.split('&&').every((raw) => {
    const term = raw.trim();
    let m = /^(\w+)\s*==\s*'([^']*)'$/.exec(term);
    if (m) return String(ctx[m[1]] ?? '') === m[2];
    m = /^(\w+)\s*=~\s*\/(.*)\/$/.exec(term);
    if (m) return new RegExp(m[2].replace(/\\\\/g, '\\')).test(String(ctx[m[1]] ?? ''));
    if (term.startsWith('!')) return !ctx[term.slice(1)];
    return !!ctx[term];
  });
}

/** Merge data-vscode-context of an element and its ancestors (the inner one wins, as in VS Code) */
function collectContext(el: HTMLElement | null): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [];
  for (let e = el; e; e = e.parentElement) {
    const raw = e.dataset?.vscodeContext;
    if (raw) {
      try {
        parts.push(JSON.parse(raw));
      } catch {
        /* ignore */
      }
    }
  }
  return Object.assign({}, ...parts.reverse(), { webviewId: 'twigline.repository' });
}

export function DevContextMenu() {
  const [menus, setMenus] = useState<MenuItem[]>([]);
  const [open, setOpen] = useState<{ x: number; y: number; items: MenuItem[]; ctx: Record<string, unknown> } | null>(null);

  useEffect(() => {
    fetch('/menus')
      .then((r) => r.json())
      .then(setMenus)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea')) return;
      const ctx = collectContext(target);
      if (!ctx.webviewSection) return;
      e.preventDefault();
      const items = menus.filter((m) => evalWhen(m.when, ctx)).sort((a, b) => a.group.localeCompare(b.group, undefined, { numeric: true }));
      if (items.length === 0) return;
      setOpen({ x: e.clientX, y: e.clientY, items, ctx });
    };
    const close = () => setOpen(null);
    window.addEventListener('contextmenu', onContext);
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('contextmenu', onContext);
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
    };
  }, [menus]);

  if (!open) return null;
  let lastGroup = '';
  const { webviewSection, ...rest } = open.ctx;
  const context = { ...rest, section: webviewSection };
  return (
    <div className="dev-menu" style={{ left: Math.min(open.x, window.innerWidth - 280), top: Math.min(open.y, window.innerHeight - open.items.length * 26 - 20) }} role="menu">
      {open.items.map((m) => {
        const group = m.group.split('@')[0];
        const sep = lastGroup && group !== lastGroup;
        lastGroup = group;
        return (
          <div key={m.command}>
            {sep && <div className="dev-menu-sep" />}
            <div
              className="dev-menu-item"
              role="menuitem"
              onClick={() => {
                setOpen(null);
                void handleCommand(m.command, context);
              }}
            >
              {m.title}
            </div>
          </div>
        );
      })}
    </div>
  );
}
