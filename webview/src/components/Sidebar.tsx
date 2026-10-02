import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { RefInfo } from '../../../shared/protocol';
import { t } from '../i18n';
import { jumpTo, runOp, selectRow, toggleCollapsed, uiAction } from '../store/actions';
import { useStore } from '../store/store';
import { cx } from '../util/format';
import { matchesFilter, parseFilter } from '../util/sidebarFilter';
import { buildTree, flattenTree, type TreeNode } from '../util/tree';
import { scrollToIndex } from './History';
import { PrChip, PrNotice, prContext, prDone, prOf } from './PullRequest';
import { Icon, IconButton, vsContext } from './ui';

// Sidebar on the left: branches, tags, remotes, stashes and submodules.
// Pressing an item only moves around in history, so it is placed only inside the History tab (History.tsx).
// Switching between "Uncommitted Changes | History" is done with the tabs at the top of the panel (Header).
// Tags, remotes and submodules, which are rarely looked at, are closed by default; empty tags and stashes are not shown.
// If a branch has a PR, its mark (PullRequest.tsx) is shown after the name.
// The filter for finding one among many branches is normally only a magnifier on the "Branches" heading, to keep it unobtrusive.
// Pressing it shows an input at the top and filters all the lists together (collapsed sections also open while filtering).

export function Sidebar() {
  const snapshot = useStore((s) => s.snapshot);
  const collapsed = useStore((s) => s.ui.collapsed);
  const repo = useStore((s) => s.boot.repo);
  const prs = useStore((s) => s.pullRequests);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  if (!snapshot) return <aside className="sidebar" />;

  const terms = parseFilter(filterText);
  const filtering = terms.length > 0;
  const keep = <T,>(items: T[], nameOf: (item: T) => string) => (filtering ? items.filter((i) => matchesFilter(nameOf(i), terms)) : items);

  const locals = keep(
    snapshot.refs.filter((r) => r.kind === 'head'),
    (r) => r.name,
  );
  const tags = keep(
    snapshot.refs.filter((r) => r.kind === 'tag'),
    (r) => r.name,
  ).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  const remotes = snapshot.remotes
    .map((rm) => ({
      rm,
      branches: keep(
        snapshot.refs.filter((r) => r.kind === 'remote' && r.remote === rm.name),
        (r) => r.name,
      ),
    }))
    .filter(({ branches }) => !filtering || branches.length > 0);
  const stashes = keep(snapshot.stashes, (s) => s.message);
  const submodules = keep(snapshot.submodules, (s) => s.path);
  // While filtering, sections with no match are hidden, and collapsed sections and folders are opened
  const sectionCollapsed = (id: string, dflt = false) => (filtering ? false : collapsed[id] ?? dflt);
  const nothing = filtering && !locals.length && !tags.length && !remotes.length && !stashes.length && !submodules.length;

  const closeFilter = () => {
    setFilterText('');
    setFilterOpen(false);
  };

  return (
    <aside className="sidebar" role="tree" aria-label={t('side.title')}>
      {filterOpen && <SideFilter text={filterText} onChange={setFilterText} onClose={closeFilter} />}
      {nothing && <div className="side-empty">{t('side.filterNone')}</div>}
      {(!filtering || locals.length > 0) && (
      <Section
        id="branches"
        title={t('side.branches')}
        collapsed={sectionCollapsed('branches', !!collapsed.branches)}
        action={!filterOpen && <IconButton icon="search" className="side-filter-btn" title={t('side.filter')} onClick={() => setFilterOpen(true)} />}
      >
        <RefTree
          expandAll={filtering}
          refs={locals}
          name={(r) => r.name}
          idPrefix="b"
          render={(r) => {
            const pr = prOf(prs, r);
            return (
              <>
                {/* The mark for the checked-out branch matches the double circle of HEAD in the graph (a check mark is confused with the chevron that opens and closes the tree) */}
                {r.isHead ? <Icon name="target" className="head-mark" title={t('side.checkedOut')} /> : <Icon name="git-branch" />}
                <span className={cx('label', r.isHead && 'head', prDone(pr) && 'pr-done')}>{leaf(r.name)}</span>
                <span className="side-trail">
                  {pr && <PrChip pr={pr} refName={r.fullName} />}
                  <Tracking r={r} />
                </span>
              </>
            );
          }}
          context={(r) => vsContext('branch.local', { repo, ref: r.name, twiglineIsHead: !!r.isHead, ...prContext(prOf(prs, r)) })}
          onClick={(r) => void revealSha(r.sha)}
          onDoubleClick={(r) => !r.isHead && void runOp({ kind: 'checkout', ref: r.name })}
        />
        <PrNotice />
      </Section>

      )}

      {tags.length > 0 && (
      <Section id="tags" title={t('side.tags')} collapsed={sectionCollapsed('tags', true)}>
        {tags.map((r) => (
          <div
            key={r.fullName}
            className="side-item"
            role="treeitem"
            data-vscode-context={vsContext('tag', { repo, ref: r.name })}
            onClick={() => void revealSha(r.sha)}
            title={r.fullName}
          >
            <Icon name="tag" />
            <span className="label">{r.name}</span>
          </div>
        ))}
      </Section>
      )}

      {(!filtering || remotes.length > 0) && (
      <Section id="remotes" title={t('side.remotes')} collapsed={sectionCollapsed('remotes', true)}>
        {remotes.map(({ rm, branches }) => {
          const key = `remote:${rm.name}`;
          const isCollapsed = sectionCollapsed(key);
          return (
            <div key={rm.name}>
              <div className="side-item folder" role="treeitem" aria-expanded={!isCollapsed} onClick={() => toggleCollapsed(key)} title={rm.fetchUrl}>
                <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} />
                <Icon name="cloud" />
                <span className="label">{rm.name}</span>
                {rm.authRequired && (
                  <span className="warn-mark" title={t('side.authRequired')}>
                    <Icon name="lock" />
                  </span>
                )}
              </div>
              {!isCollapsed && (
                <div className="indent">
                  <RefTree
                    expandAll={filtering}
                    refs={branches}
                    name={(r) => r.name.slice(rm.name.length + 1)}
                    idPrefix={`r:${rm.name}`}
                    render={(r) => {
                      const pr = prOf(prs, r);
                      return (
                        <>
                          <Icon name="git-branch" />
                          <span className={cx('label', prDone(pr) && 'pr-done')}>{leaf(r.name.slice(rm.name.length + 1))}</span>
                          {pr && (
                            <span className="side-trail">
                              <PrChip pr={pr} refName={r.fullName} />
                            </span>
                          )}
                        </>
                      );
                    }}
                    context={(r) => vsContext('branch.remote', { repo, ref: r.name, remote: rm.name, ...prContext(prOf(prs, r)) })}
                    onClick={(r) => void revealSha(r.sha)}
                    onDoubleClick={(r) =>
                      void import('../commands').then((m) => m.handleCommand('twigline.remoteBranch.checkout', { ref: r.name, remote: rm.name }))
                    }
                  />
                </div>
              )}
            </div>
          );
        })}
      </Section>
      )}

      {stashes.length > 0 && (
      <Section id="stashes" title={t('side.stashes')} collapsed={sectionCollapsed('stashes')}>
        {stashes.map((s) => (
          <div
            key={s.sha}
            className="side-item"
            role="treeitem"
            data-vscode-context={vsContext('stash', { repo, index: s.index, sha: s.sha })}
            onClick={() => {
              selectRow(s.sha, {});
            }}
            title={s.message}
          >
            <Icon name="archive" />
            <span className="label">{s.message}</span>
          </div>
        ))}
      </Section>
      )}

      {submodules.length > 0 && (
        <Section id="submodules" title={t('side.submodules')} collapsed={sectionCollapsed('submodules', true)}>
          {submodules.map((s) => (
            <div key={s.path} className="side-item" role="treeitem" onDoubleClick={() => uiAction({ kind: 'openRepo', path: s.path })} title={t('side.openSubmodule')}>
              <Icon name="file-submodule" />
              <span className="label">{s.path}</span>
            </div>
          ))}
        </Section>
      )}
    </aside>
  );
}

async function revealSha(sha: string): Promise<void> {
  const idx = await jumpTo(sha);
  if (idx >= 0) scrollToIndex(idx);
}

function leaf(name: string): string {
  const i = name.lastIndexOf('/');
  return i >= 0 ? name.slice(i + 1) : name;
}

function Tracking({ r }: { r: RefInfo }) {
  if (r.gone) return <span className="track gone" title={t('side.upstreamGone')}>✕</span>;
  if (!r.ahead && !r.behind) return null;
  return (
    <span className="track" title={t('side.tracking', r.upstream ?? '')}>
      {r.ahead ? `↑${r.ahead}` : ''}
      {r.behind ? `↓${r.behind}` : ''}
    </span>
  );
}

// No count badge on headings. Badges are used only for counts that need action, like the "Uncommitted Changes" tab.
function Section({ id, title, collapsed, action, children }: { id: string; title: string; collapsed?: boolean; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="side-sec">
      <div className="side-sec-title" role="treeitem" aria-expanded={!collapsed} onClick={() => toggleCollapsed(id, !!collapsed)}>
        <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} />
        <span>{title}</span>
        {action && (
          <span className="side-sec-action" onClick={(e) => e.stopPropagation()}>
            {action}
          </span>
        )}
      </div>
      {!collapsed && <div className="side-sec-body">{children}</div>}
    </div>
  );
}

/** Filter input for the lists. Closes when left empty or with Esc */
function SideFilter({ text, onChange, onClose }: { text: string; onChange: (text: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="side-filter">
      <Icon name="search" />
      <input
        ref={ref}
        value={text}
        placeholder={t('side.filterPlaceholder')}
        aria-label={t('side.filter')}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
        onBlur={() => {
          if (!text.trim()) onClose();
        }}
        data-vscode-context='{"preventDefaultContextMenuItems":false}'
      />
      {text && <IconButton icon="close" title={t('side.filterClear')} onMouseDown={(e) => e.preventDefault()} onClick={() => onChange('')} />}
    </div>
  );
}

/** Group slash-separated branch names into folders */
function RefTree({
  expandAll,
  refs,
  name,
  idPrefix,
  render,
  context,
  onClick,
  onDoubleClick,
}: {
  /** Open collapsed folders too while filtering */
  expandAll?: boolean;
  refs: RefInfo[];
  name: (r: RefInfo) => string;
  idPrefix: string;
  render: (r: RefInfo) => ReactNode;
  context: (r: RefInfo) => string;
  onClick: (r: RefInfo) => void;
  onDoubleClick: (r: RefInfo) => void;
}) {
  const collapsedAll = useStore((s) => s.ui.collapsed);
  const [, force] = useState(0);
  const tree = useMemo(() => buildTree(refs, name), [refs, name]);
  const collapsed = useMemo(() => {
    const set = new Set<string>();
    if (expandAll) return set;
    for (const [k, v] of Object.entries(collapsedAll)) if (v && k.startsWith(`${idPrefix}/`)) set.add(k.slice(idPrefix.length + 1));
    return set;
  }, [collapsedAll, idPrefix, expandAll]);
  const flat = flattenTree(tree as TreeNode<RefInfo>[], collapsed);
  return (
    <>
      {flat.map(({ node, depth }) => {
        // The base indentation belongs to the CSS (.side-item / .indent .side-item); only the depth is passed here
        const pad = { '--depth': depth } as CSSProperties;
        if (!node.item) {
          const isCollapsed = collapsed.has(node.path);
          return (
            <div
              key={`f:${node.path}`}
              className="side-item folder"
              role="treeitem"
              aria-expanded={!isCollapsed}
              style={pad}
              onClick={() => {
                toggleCollapsed(`${idPrefix}/${node.path}`);
                force((x) => x + 1);
              }}
            >
              <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} />
              <Icon name="folder" />
              <span className="label">{node.name}</span>
            </div>
          );
        }
        const r = node.item;
        return (
          <div
            key={r.fullName}
            className="side-item"
            role="treeitem"
            style={pad}
            title={r.upstream ? `${r.name} → ${r.upstream}` : r.name}
            data-vscode-context={context(r)}
            onClick={() => onClick(r)}
            onDoubleClick={() => onDoubleClick(r)}
          >
            {render(r)}
          </div>
        );
      })}
    </>
  );
}
