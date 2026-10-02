import { useMemo, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { FileStatusCode } from '../../../shared/protocol';
import { t } from '../i18n';
import { useStore } from '../store/store';
import { basename, cx, dirname, statusLabel } from '../util/format';
import { buildTree, flattenTree } from '../util/tree';
import { Icon, IconButton } from './ui';

export interface FileItem {
  path: string;
  status: FileStatusCode;
  oldPath?: string;
  additions?: number;
  deletions?: number;
  binary?: boolean;
  submodule?: boolean;
  conflict?: string;
}

interface Props<F extends FileItem> {
  files: F[];
  selectedPaths: string[];
  onSelect: (f: F, mods: { ctrl: boolean; shift: boolean }) => void;
  onOpen?: (f: F) => void;
  contextFor?: (f: F) => string;
  showStats?: boolean;
  /** Checkbox (toggle staging in the single-list view) */
  checkbox?: { checked: (f: F) => boolean | 'mixed'; toggle: (f: F) => void };
  /** One-click button at the right end of a row (stage / unstage per file). Visible when the row is hovered or selected */
  rowAction?: { icon: string; title: string; run: (f: F) => void };
  /** Space key (toggle staging of the selected file) */
  onSpace?: (selected: F[]) => void;
  /** Move between the two lists by dragging */
  drag?: { group: string; onDrop: (paths: string[], fromGroup: string) => void };
  emptyText?: ReactNode;
}

const DRAG_TYPE = 'application/x-twigline-files';

export function FileList<F extends FileItem>(p: Props<F>) {
  const view = useStore((s) => s.ui.fileView);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dropping, setDropping] = useState(false);
  const selected = useMemo(() => new Set(p.selectedPaths), [p.selectedPaths]);

  const entries = useMemo(() => {
    if (view === 'list') return p.files.map((f) => ({ file: f as F | undefined, depth: 0, folder: undefined as string | undefined, name: '' }));
    const tree = buildTree(p.files, (f) => f.path);
    return flattenTree(tree, collapsed).map(({ node, depth }) => ({
      file: node.item,
      depth,
      folder: node.item ? undefined : node.path,
      name: node.name,
    }));
  }, [p.files, view, collapsed]);

  const ordered = entries.filter((e) => e.file).map((e) => e.file!);

  const onKeyDown = (e: KeyboardEvent) => {
    if (ordered.length === 0) return;
    const cur = ordered.findIndex((f) => selected.has(f.path));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? Math.min(ordered.length - 1, cur + 1) : Math.max(0, cur - 1);
      p.onSelect(ordered[next], { ctrl: false, shift: e.shiftKey });
      const el = (e.currentTarget as HTMLElement).querySelector(`[data-path="${CSS.escape(ordered[next].path)}"]`) as HTMLElement | null;
      el?.focus();
    } else if (e.key === ' ' && p.onSpace) {
      e.preventDefault();
      p.onSpace(ordered.filter((f) => selected.has(f.path)));
    } else if (e.key === 'Enter' && p.onOpen && cur >= 0) {
      e.preventDefault();
      p.onOpen(ordered[cur]);
    }
  };

  const onDragStart = (e: DragEvent, f: F) => {
    if (!p.drag) return;
    const paths = selected.has(f.path) ? p.selectedPaths : [f.path];
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ paths, from: p.drag.group }));
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div
      className={cx('file-list', dropping && 'dropping')}
      role="listbox"
      aria-multiselectable
      onKeyDown={onKeyDown}
      onDragOver={(e) => {
        if (p.drag && e.dataTransfer.types.includes(DRAG_TYPE)) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        const raw = e.dataTransfer.getData(DRAG_TYPE);
        if (!raw || !p.drag) return;
        const { paths, from } = JSON.parse(raw) as { paths: string[]; from: string };
        if (from !== p.drag.group) p.drag.onDrop(paths, from);
      }}
    >
      {entries.length === 0 && p.emptyText && <div className="list-empty small">{p.emptyText}</div>}
      {entries.map((e, i) => {
        if (!e.file) {
          const folder = e.folder!;
          const isCollapsed = collapsed.has(folder);
          return (
            <div
              key={`d:${folder}:${i}`}
              className="file-row folder"
              style={{ paddingLeft: 6 + e.depth * 14 }}
              onClick={() => {
                const next = new Set(collapsed);
                if (isCollapsed) next.delete(folder);
                else next.add(folder);
                setCollapsed(next);
              }}
            >
              <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} />
              <Icon name="folder" />
              <span className="name">{e.name}</span>
            </div>
          );
        }
        const f = e.file;
        const isSel = selected.has(f.path);
        const cb = p.checkbox?.checked(f);
        return (
          <div
            key={f.path}
            data-path={f.path}
            className={cx('file-row', isSel && 'selected')}
            role="option"
            aria-selected={isSel}
            tabIndex={isSel ? 0 : -1}
            style={{ paddingLeft: 6 + e.depth * 14 }}
            data-vscode-context={p.contextFor?.(f)}
            draggable={!!p.drag}
            onDragStart={(ev) => onDragStart(ev, f)}
            onMouseDown={(ev) => {
              if (ev.button === 2) {
                if (!isSel) p.onSelect(f, { ctrl: false, shift: false });
                return;
              }
              if (ev.button !== 0) return;
              if ((ev.target as HTMLElement).closest('.cb, .row-action')) return;
              p.onSelect(f, { ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey });
            }}
            onDoubleClick={() => (p.checkbox ? p.checkbox.toggle(f) : p.onOpen?.(f))}
            title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
          >
            {p.checkbox && (
              <span
                className={cx('cb', cb === true && 'on', cb === 'mixed' && 'mixed')}
                role="checkbox"
                aria-checked={cb === 'mixed' ? 'mixed' : cb}
                onClick={() => p.checkbox!.toggle(f)}
              >
                {cb === true && <Icon name="check" />}
                {cb === 'mixed' && <Icon name="remove" />}
              </span>
            )}
            <span className={cx('st', `st-${f.status === '?' ? 'u' : f.status.toLowerCase()}`)} title={statusLabel(f.status)}>
              {f.status}
            </span>
            {f.submodule && <Icon name="file-submodule" />}
            <span className="name">{view === 'tree' ? basename(f.path) : basename(f.path)}</span>
            {view === 'list' && dirname(f.path) && <span className="path">{dirname(f.path)}</span>}
            {f.oldPath && <span className="path">← {f.oldPath}</span>}
            {f.conflict && <span className="path">{conflictLabel(f.conflict)}</span>}
            {p.showStats && (
              <span className="num">
                {f.binary ? (
                  t('files.binary')
                ) : (
                  <>
                    {f.additions ? <span className="add">+{f.additions}</span> : null}
                    {f.deletions ? <span className="del">−{f.deletions}</span> : null}
                  </>
                )}
              </span>
            )}
            {p.rowAction && (
              <IconButton
                className="row-action"
                icon={p.rowAction.icon}
                title={p.rowAction.title}
                onClick={(ev) => {
                  ev.stopPropagation();
                  p.rowAction!.run(f);
                }}
                onDoubleClick={(ev) => ev.stopPropagation()}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function conflictLabel(code: string): string {
  switch (code) {
    case 'DD':
      return t('conflict.bothDeleted');
    case 'AU':
      return t('conflict.addedByUs');
    case 'UD':
      return t('conflict.deletedByThem');
    case 'UA':
      return t('conflict.addedByThem');
    case 'DU':
      return t('conflict.deletedByUs');
    case 'AA':
      return t('conflict.bothAdded');
    default:
      return t('conflict.bothModified');
  }
}
