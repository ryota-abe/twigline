import { useEffect, useMemo, useState } from 'react';
import type { IssueLinkSettings, IssueLinksPreview, IssueLinksState, IssueTrackerSetting, IssueTrackerType, MessageLink, SettingsTarget } from '../../../../shared/protocol';
import { t } from '../../i18n';
import { closeDialog, getRpc, reportError, toast } from '../../store/actions';
import { useStore } from '../../store/store';
import { isCancelled } from '../../rpc/RpcClient';
import { cx } from '../../util/format';
import { Checkbox, IconButton, Spinner } from '../ui';
import { DialogShell, Field, Warning } from './Dialog';

// "Commit Message Links": issue trackers (twigline.issueLinks.trackers) and the built-in references (twigline.issueLinks.builtIn).
// The host finds the links; this dialog shows what the settings being edited would link in recent commits before saving.

/** A tracker being edited. Keys are edited as text ("PROJ, UI") */
interface Draft extends IssueTrackerSetting {
  id: number;
  keysText: string;
}

const TYPES: IssueTrackerType[] = ['jira', 'backlog', 'redmine', 'youtrack', 'linear', 'azureBoards', 'github', 'custom'];
const KEYED = new Set<IssueTrackerType>(['jira', 'backlog', 'youtrack', 'linear']);
const URL_PLACEHOLDER: Partial<Record<IssueTrackerType, string>> = {
  jira: 'https://example.atlassian.net',
  backlog: 'https://example.backlog.jp',
  redmine: 'https://redmine.example.com',
  youtrack: 'https://example.youtrack.cloud',
  custom: 'https://example.com/issues/$1',
};
/** What the built-in references link, per service */
const BUILT_IN_REFS: Record<NonNullable<IssueLinksState['remote']>['service'], string> = {
  github: '#123 · GH-123 · owner/repo#123',
  gitlab: '#123 · !123 · group/project#123',
  bitbucket: '#123 · pull request #123',
  azure: '#123 · !123 · Merged PR 123',
};

let nextId = 1;
const toDraft = (s: IssueTrackerSetting): Draft => ({ ...s, id: nextId++, keysText: (s.keys ?? []).join(', ') });
const parseKeys = (text: string) => [...new Set(text.split(/[\s,]+/).map((k) => k.trim().toUpperCase()).filter(Boolean))];

/** The setting saved for a draft: only the fields its type uses */
function fromDraft(d: Draft): IssueTrackerSetting {
  const s: IssueTrackerSetting = { type: d.type };
  const put = (k: 'url' | 'workspace' | 'org' | 'project' | 'repo' | 'host' | 'pattern') => {
    const v = d[k]?.trim();
    if (v) s[k] = v;
  };
  switch (d.type) {
    case 'jira':
    case 'backlog':
    case 'youtrack':
      put('url');
      break;
    case 'linear':
      put('workspace');
      break;
    case 'redmine':
      put('url');
      break;
    case 'azureBoards':
      put('org');
      put('project');
      break;
    case 'github':
      put('repo');
      put('host');
      break;
    case 'custom':
      put('pattern');
      put('url');
      break;
  }
  if (KEYED.has(d.type)) {
    const keys = parseKeys(d.keysText);
    if (keys.length > 0) s.keys = keys;
  }
  return s;
}

export function IssueLinksDialog() {
  const repo = useStore((s) => s.boot.repo);
  const sha = useStore((s) => (s.detail && !s.detail.compareTo ? s.detail.sha : undefined));
  const [state, setState] = useState<IssueLinksState | null>(null);
  const [builtIn, setBuiltIn] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [target, setTarget] = useState<SettingsTarget>('user');
  const [preview, setPreview] = useState<IssueLinksPreview | null>(null);

  useEffect(() => {
    getRpc()
      .request('links/get', { repo })
      .then((s) => {
        setState(s);
        setBuiltIn(s.settings.builtIn);
        setDrafts(s.settings.trackers.map(toDraft));
        setTarget(s.source !== 'user' && s.targets.includes('workspace') ? 'workspace' : 'user');
      })
      .catch((e) => {
        closeDialog();
        reportError(e);
      });
  }, [repo]);

  const settings: IssueLinkSettings = useMemo(() => ({ builtIn, trackers: drafts.map(fromDraft) }), [builtIn, drafts]);
  const settingsKey = JSON.stringify(settings);

  useEffect(() => {
    if (!state) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      getRpc()
        .request('links/preview', { repo, settings, sha }, ctrl.signal)
        .then(setPreview)
        .catch((e) => {
          if (!isCancelled(e)) reportError(e);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // settingsKey stands for settings (a new object on every render)
  }, [state, settingsKey, sha, repo]);

  const update = (id: number, patch: Partial<Draft>) => setDrafts((list) => list.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const groupOf = (i: number | null) => preview?.groups.find((g) => g.tracker === i);
  const incomplete = preview?.groups.some((g) => g.tracker !== null && !g.valid) ?? false;

  if (!state) {
    return (
      <DialogShell title={t('links.title')} wide>
        <Spinner />
      </DialogShell>
    );
  }

  return (
    <DialogShell
      title={t('links.title')}
      wide
      okLabel={t('save')}
      okDisabled={incomplete}
      onOk={async () => {
        try {
          await getRpc().request('links/save', { repo, settings, target });
          toast('info', t('links.saved'));
          closeDialog();
        } catch (e) {
          reportError(e);
        }
      }}
    >
      <p className="dim">{t('links.intro')}</p>

      <h4>{t('links.trackers')}</h4>
      {drafts.length === 0 && <p className="dim">{t('links.noTrackers')}</p>}
      {drafts.map((d, i) => (
        <TrackerCard
          key={d.id}
          draft={d}
          keys={state.keys}
          group={groupOf(i)}
          commits={preview?.commits}
          onChange={(patch) => update(d.id, patch)}
          onRemove={() => setDrafts((list) => list.filter((x) => x.id !== d.id))}
        />
      ))}
      <span className="row">
        <select
          className="select"
          aria-label={t('links.add')}
          value=""
          onChange={(e) => {
            const type = e.target.value as IssueTrackerType;
            if (type) setDrafts((list) => [...list, toDraft({ type })]);
          }}
        >
          <option value="">{t('links.add')}</option>
          {TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`links.type.${type}`)}
            </option>
          ))}
        </select>
      </span>

      <h4>{t('links.builtIn')}</h4>
      <Checkbox checked={builtIn} disabled={!state.remote && !builtIn} onChange={setBuiltIn} label={t('links.builtInLabel')} />
      <p className="dim indent">
        {state.remote
          ? t('links.builtInRemote', t(`links.service.${state.remote.service}`), `${state.remote.name}: ${state.remote.path}`, BUILT_IN_REFS[state.remote.service])
          : t('links.builtInNoRemote')}
      </p>
      {builtIn && <GroupSummary group={groupOf(null)} commits={preview?.commits} />}

      <h4>{t('links.preview')}</h4>
      {preview?.selected ? (
        <pre className="msg-body links-preview">
          <Highlighted text={preview.selected.message} links={preview.selected.links} />
        </pre>
      ) : (
        <p className="dim">{t('links.previewNone')}</p>
      )}

      <h4>{t('links.saveTo')}</h4>
      <div role="radiogroup" aria-label={t('links.saveTo')}>
        {(['workspace', 'user'] as const).map((v) => {
          const disabled = !state.targets.includes(v);
          return (
            <label key={v} className={cx('radio block', disabled && 'disabled')}>
              <input type="radio" checked={target === v} disabled={disabled} onChange={() => setTarget(v)} />
              <span>
                <b>{t(`links.target.${v}`)}</b>
                <span className="dim block">{disabled ? t('links.target.outside') : t(`links.target.${v}.desc`)}</span>
              </span>
            </label>
          );
        })}
      </div>
      {target === 'user' && state.source === 'workspace' && <Warning>{t('links.workspaceWins')}</Warning>}
    </DialogShell>
  );
}

function TrackerCard({
  draft,
  keys,
  group,
  commits,
  onChange,
  onRemove,
}: {
  draft: Draft;
  keys: IssueLinksState['keys'];
  group?: IssueLinksPreview['groups'][number];
  commits?: number;
  onChange: (patch: Partial<Draft>) => void;
  onRemove: () => void;
}) {
  const text = (field: 'url' | 'workspace' | 'org' | 'project' | 'repo' | 'host' | 'pattern', label: string, placeholder: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <input className="input" value={draft[field] ?? ''} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange({ [field]: e.target.value })} />
    </Field>
  );
  const chosen = new Set(parseKeys(draft.keysText));
  const toggle = (key: string) => {
    const next = chosen.has(key) ? [...chosen].filter((k) => k !== key) : [...chosen, key];
    onChange({ keysText: next.join(', ') });
  };
  const type = draft.type;
  return (
    <div className="tracker-card">
      <div className="tracker-head">
        <b>{t(`links.type.${type}`)}</b>
        <span className="dim ellipsis">{t(`links.form.${type}`)}</span>
        <span className="spacer" />
        <IconButton icon="trash" title={t('links.remove')} onClick={onRemove} />
      </div>
      {(type === 'jira' || type === 'backlog' || type === 'youtrack' || type === 'redmine') && text('url', t('links.field.url'), URL_PLACEHOLDER[type]!)}
      {type === 'linear' && text('workspace', t('links.field.workspace'), 'acme', 'https://linear.app/<workspace>')}
      {type === 'azureBoards' && (
        <>
          {text('org', t('links.field.org'), 'my-org')}
          {text('project', t('links.field.project'), 'My Project')}
        </>
      )}
      {type === 'github' && (
        <>
          {text('repo', t('links.field.repo'), 'owner/repo')}
          {text('host', t('links.field.host'), 'github.com')}
        </>
      )}
      {type === 'custom' && (
        <>
          {text('pattern', t('links.field.pattern'), '\\b(TICKET-[0-9]+)\\b')}
          {text('url', t('links.field.urlTemplate'), URL_PLACEHOLDER.custom!, t('links.field.urlTemplateHint'))}
        </>
      )}
      {KEYED.has(type) && (
        <Field label={t('links.field.keys')} hint={chosen.size === 0 ? t('links.field.keysAny') : undefined}>
          <input className="input" value={draft.keysText} placeholder="PROJ, UI" spellCheck={false} onChange={(e) => onChange({ keysText: e.target.value })} />
          {keys.length > 0 && (
            <span className="key-candidates">
              <span className="dim">{t('links.field.keysFound')}</span>
              {keys.map((k) => (
                <button key={k.key} type="button" className={cx('pill', chosen.has(k.key) && 'on')} aria-pressed={chosen.has(k.key)} onClick={() => toggle(k.key)}>
                  {k.key} <span className="dim">{k.count}</span>
                </button>
              ))}
            </span>
          )}
        </Field>
      )}
      <GroupSummary group={group} commits={commits} />
    </div>
  );
}

/** What a tracker (or the built-in references) links in recent commits */
function GroupSummary({ group, commits }: { group?: IssueLinksPreview['groups'][number]; commits?: number }) {
  if (!group || commits === undefined) return null;
  if (!group.valid) return <p className="field-error">{group.tracker === null ? t('links.builtInNoRemote') : t('links.incomplete')}</p>;
  return (
    <div className="links-examples">
      <span className="dim">{t('links.matches', String(commits), String(group.count))}</span>
      {group.examples.map((e) => (
        <span key={e.text} className="mono ellipsis" title={e.url}>
          <span className="links-hit">{e.text}</span> → {e.url}
        </span>
      ))}
    </div>
  );
}

function Highlighted({ text, links }: { text: string; links: MessageLink[] }) {
  const parts: React.ReactNode[] = [];
  let pos = 0;
  for (const l of links) {
    if (l.start < pos) continue;
    if (l.start > pos) parts.push(text.slice(pos, l.start));
    parts.push(
      <span key={l.start} className="links-hit" title={l.url}>
        {text.slice(l.start, l.end)}
      </span>,
    );
    pos = l.end;
  }
  if (pos < text.length) parts.push(text.slice(pos));
  return <>{parts}</>;
}
