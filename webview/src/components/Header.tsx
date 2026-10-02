import type { ViewKind } from '../../../shared/protocol';
import { handleCommand } from '../commands';
import { t } from '../i18n';
import { openDialog, setView, uncommittedCount } from '../store/actions';
import { useStore } from '../store/store';
import { cx, shortSha } from '../util/format';
import { HistoryFilter } from './History';
import { PrChip, prOf } from './PullRequest';
import { Icon, MenuButton, MenuItem, Spinner } from './ui';

// One row across the top of the panel (full width): the "Uncommitted Changes | History" tabs, history search and filter, the running operation,
// the current branch (pressing it opens actions for the current branch; with its PR mark if there is one), and actions for the whole repository (...).
// Actions for the whole panel are not put in the editor title bar (they would sit beside VS Code's own buttons at a different level).

export function Header() {
  const view = useStore((s) => s.view);
  const count = useStore(uncommittedCount);
  return (
    <div className="header">
      <div className="tabs" role="tablist">
        <Tab view="fileStatus" current={view} icon="diff-multiple" label={t('tab.uncommitted')} count={count} />
        <Tab view="history" current={view} icon="history" label={t('tab.history')} />
      </div>
      {view === 'history' && <HistoryFilter />}
      <span className="spacer" />
      <Busy />
      <HeadStatus />
      <PanelMenu />
    </div>
  );
}

interface MenuEntry {
  command: string;
  label: () => string;
  key?: { other: string; mac: string };
  /** Needs a checked-out branch (not usable in a detached HEAD) */
  needsBranch?: boolean;
}

// Menus are split by the scope they work on. Actions on the working tree (stash, discard) are inside the "Uncommitted Changes" tab.
// Every item runs the same command as twigline.panel.* in the Command Palette.

/** Menu on the current branch name: actions that work on the current branch */
const HEAD_MENU: MenuEntry[][] = [
  [
    { command: 'twigline.panel.pull', label: () => t('menu.pull'), needsBranch: true },
    { command: 'twigline.panel.push', label: () => t('menu.push'), needsBranch: true },
  ],
  [
    { command: 'twigline.panel.merge', label: () => t('menu.merge') },
    { command: 'twigline.panel.rebase', label: () => t('menu.rebase') },
  ],
];

/** "...": actions that work on the whole repository */
const PANEL_MENU: MenuEntry[][] = [
  [
    { command: 'twigline.panel.fetch', label: () => t('menu.fetch') },
    { command: 'twigline.panel.pushBranches', label: () => t('menu.pushBranches') },
  ],
  [
    { command: 'twigline.panel.branch', label: () => t('menu.branch') },
    { command: 'twigline.panel.tag', label: () => t('menu.tag') },
  ],
  [
    { command: 'twigline.refresh', label: () => t('menu.refresh'), key: { other: 'Ctrl+Shift+R', mac: '⇧⌘R' } },
    { command: 'twigline.panel.settings', label: () => t('menu.settings') },
  ],
];

function CommandMenuItems({ groups, close }: { groups: MenuEntry[][]; close: () => void }) {
  const mac = useStore((s) => s.init?.platform === 'darwin');
  const detached = useStore((s) => !s.snapshot?.head.branch);
  return groups.map((group, i) => (
    <div key={i} className="menu-group">
      {i > 0 && <div className="popup-sep" role="separator" />}
      {group.map((item) => (
        <MenuItem
          key={item.command}
          label={item.label()}
          hint={item.key && (mac ? item.key.mac : item.key.other)}
          disabled={item.needsBranch && detached}
          onSelect={() => {
            close();
            void handleCommand(item.command, {});
          }}
        />
      ))}
    </div>
  ));
}

function PanelMenu() {
  return (
    <MenuButton icon="ellipsis" title={t('menu.title')} align="right" direction="down" menu>
      {(close) => <CommandMenuItems groups={PANEL_MENU} close={close} />}
    </MenuButton>
  );
}

/** Tabs that switch the whole screen. They are a level above search and filter, so icon, weight and a divider make that clear */
function Tab({ view, current, icon, label, count }: { view: ViewKind; current: ViewKind; icon: string; label: string; count?: number }) {
  const on = view === current;
  return (
    <button type="button" role="tab" aria-selected={on} className={cx('tab', on && 'on')} onClick={() => setView(view)}>
      <Icon name={icon} />
      {label}
      {!!count && <span className="count">{count}</span>}
    </button>
  );
}

function Busy() {
  const top = useStore((s) => s.busy[s.busy.length - 1]);
  if (!top) return null;
  return (
    <span className="busy" title={top.message ?? top.title}>
      <Spinner small />
      <span className="busy-text">
        {top.title}
        {top.message ? ` — ${top.message}` : ''}
      </span>
    </span>
  );
}

/**
 * The current branch with ahead / behind. Pressing the name opens actions for the current branch; pressing the counts opens the push / pull dialog.
 * If the branch has a PR, its mark (pressing it opens the browser) is shown after the name
 */
function HeadStatus() {
  const head = useStore((s) => s.snapshot?.head);
  const headRef = useStore((s) => s.snapshot?.refs.find((r) => r.kind === 'head' && r.isHead));
  const pr = useStore((s) => (headRef ? prOf(s.pullRequests, headRef) : undefined));
  if (!head) return null;
  const name = head.branch ?? (head.sha ? shortSha(head.sha) : t('detachedHead'));
  return (
    <span className="head-status">
      <MenuButton
        icon={head.branch ? 'git-branch' : 'git-commit'}
        label={name}
        title={head.upstream ? `${t('head.menu')}\n${t('side.tracking', head.upstream)}` : t('head.menu')}
        align="right"
        direction="down"
        menu
      >
        {(close) => <CommandMenuItems groups={HEAD_MENU} close={close} />}
      </MenuButton>
      {pr && headRef && <PrChip pr={pr} refName={headRef.fullName} />}
      {head.behind > 0 && (
        <button type="button" className="sync" onClick={() => openDialog('pull')} title={t('head.behind', String(head.behind))}>
          ↓{head.behind}
        </button>
      )}
      {head.ahead > 0 && (
        <button type="button" className="sync" onClick={() => openDialog('push')} title={t('head.ahead', String(head.ahead))}>
          ↑{head.ahead}
        </button>
      )}
    </span>
  );
}
