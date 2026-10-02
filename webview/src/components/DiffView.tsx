import { useVirtualizer } from '@tanstack/react-virtual';
import { diffWordsWithSpace } from 'diff';
import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import type { DiffHunk, DiffLine, FileDiff } from '../../../shared/protocol';
import { t } from '../i18n';
import { applyLines, setDiffOpts, uiAction } from '../store/actions';
import { set as setStore, useStore } from '../store/store';
import { useSyntax } from '../syntax/highlighter';
import { FONT_BOLD, FONT_ITALIC, FONT_STRIKETHROUGH, FONT_UNDERLINE, mergeHighlights, type Tok } from '../syntax/tokens';
import { cx, shortSha } from '../util/format';
import { Button, Checkbox, Empty, Icon, IconButton, Select, Spinner } from './ui';

// Showing and operating on a diff. Drawn by hand to support hunk and line operations.

const LINE_HEIGHT = 20;

type Row = { kind: 'hunk'; hunk: DiffHunk } | { kind: 'line'; line: DiffLine; hunk: DiffHunk };

export function DiffView({ diff, onShowAll }: { diff: FileDiff; onShowAll?: () => void }) {
  const loading = useStore((s) => s.diffLoading);
  const lineSel = useStore((s) => s.lineSel);
  const lineAnchor = useStore((s) => s.lineAnchor);
  const opts = useStore((s) => s.diffOpts);
  const syntaxEnabled = useStore((s) => s.config?.syntaxHighlight ?? true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const target = diff.target;
  const untracked = diff.fileMode === 'untracked';
  const canStage = diff.lineOps && target.kind === 'worktree';
  const canDiscard = diff.lineOps && target.kind === 'worktree' && !untracked;
  const canUnstage = diff.lineOps && target.kind === 'index';
  const interactive = canStage || canUnstage;

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const h of diff.hunks) {
      out.push({ kind: 'hunk', hunk: h });
      for (const l of h.lines) out.push({ kind: 'line', line: l, hunk: h });
    }
    return out;
  }, [diff]);

  const changeOrder = useMemo(() => {
    const ids: number[] = [];
    for (const h of diff.hunks) for (const l of h.lines) if (l.kind !== ' ') ids.push(l.id);
    const pos = new Map(ids.map((id, i) => [id, i]));
    return { ids, pos };
  }, [diff]);

  const maxChars = useMemo(() => {
    let m = 0;
    for (const h of diff.hunks) for (const l of h.lines) if (l.text.length > m) m = l.text.length;
    return Math.min(m, 2000);
  }, [diff]);

  const words = useWordDiff(diff);
  const syntax = useSyntax(diff, syntaxEnabled);
  const selSet = useMemo(() => new Set(lineSel), [lineSel]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 30,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [diff.path, diff.target.kind]);

  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const selectRange = useCallback(
    (from: number, to: number) => {
      const a = changeOrder.pos.get(from);
      const b = changeOrder.pos.get(to);
      if (a === undefined || b === undefined) return [to];
      return changeOrder.ids.slice(Math.min(a, b), Math.max(a, b) + 1);
    },
    [changeOrder],
  );

  const onGutterDown = (e: MouseEvent, line: DiffLine) => {
    if (!interactive || line.kind === ' ' || e.button !== 0) return;
    e.preventDefault();
    dragging.current = true;
    if (e.shiftKey && lineAnchor !== null) {
      setStore({ lineSel: selectRange(lineAnchor, line.id) });
    } else if (e.ctrlKey || e.metaKey) {
      setStore({ lineSel: selSet.has(line.id) ? lineSel.filter((x) => x !== line.id) : [...lineSel, line.id], lineAnchor: line.id });
    } else {
      setStore({ lineSel: [line.id], lineAnchor: line.id });
    }
    scrollRef.current?.focus({ preventScroll: true });
  };
  const onGutterEnter = (line: DiffLine) => {
    if (!dragging.current || line.kind === ' ' || lineAnchor === null) return;
    setStore({ lineSel: selectRange(lineAnchor, line.id) });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && lineSel.length > 0) {
      setStore({ lineSel: [], lineAnchor: null });
    } else if (e.key === ' ' && lineSel.length > 0 && interactive) {
      e.preventDefault();
      void applyLines(diff, lineSel, canUnstage ? 'unstage' : 'stage');
    }
  };

  const hunkIds = (h: DiffHunk) => h.lines.filter((l) => l.kind !== ' ').map((l) => l.id);

  const targetLabel =
    target.kind === 'worktree'
      ? untracked
        ? t('diff.untracked')
        : t('diff.unstaged')
      : target.kind === 'index'
        ? t('diff.staged')
        : target.kind === 'commit'
          ? shortSha(target.sha)
          : `${shortSha(target.from)}..${shortSha(target.to)}`;

  return (
    <div className="diff">
      <div className="diff-head">
        <span className="path" title={diff.path}>
          {diff.path}
        </span>
        <span className="dim">{targetLabel}</span>
        <span className="spacer" />
        {loading && <Spinner small />}
        <span className="dim enc" title={t('diff.encoding')}>
          {diff.encoding}
        </span>
        <Select
          value={String(opts.context)}
          title={t('diff.context')}
          options={[0, 1, 3, 5, 10, 25].map((n) => ({ value: String(n), label: t('diff.contextN', String(n)) }))}
          onChange={(v) => setDiffOpts({ context: Number(v) })}
        />
        <Checkbox checked={opts.ignoreWhitespace} onChange={(v) => setDiffOpts({ ignoreWhitespace: v })} label={t('diff.ignoreWs')} />
        <IconButton icon="go-to-file" title={t('diff.openInEditor')} onClick={() => uiAction({ kind: 'openDiff', target, path: diff.path })} />
      </div>
      <DiffBody
        diff={diff}
        rows={rows}
        virtualizer={virtualizer}
        scrollRef={scrollRef}
        maxChars={maxChars}
        words={words}
        syntax={syntax}
        selSet={selSet}
        interactive={interactive}
        onGutterDown={onGutterDown}
        onGutterEnter={onGutterEnter}
        onKeyDown={onKeyDown}
        hunkButtons={(h) => (
          <span className="hunk-btns">
            {canDiscard && (
              <Button small onClick={() => void applyLines(diff, hunkIds(h), 'discard')}>
                {t('diff.discardHunk')}
              </Button>
            )}
            {canStage && (
              <Button small onClick={() => void applyLines(diff, hunkIds(h), 'stage')}>
                {t('diff.stageHunk')}
              </Button>
            )}
            {canUnstage && (
              <Button small onClick={() => void applyLines(diff, hunkIds(h), 'unstage')}>
                {t('diff.unstageHunk')}
              </Button>
            )}
          </span>
        )}
      />
      {diff.truncated && (
        <div className="diff-foot">
          {t('diff.truncated', String(diff.totalLines))}
          {onShowAll && (
            <Button small onClick={onShowAll}>
              {t('diff.showAll')}
            </Button>
          )}
        </div>
      )}
      {!diff.lineOps && (target.kind === 'worktree' || target.kind === 'index') && opts.ignoreWhitespace && diff.hunks.length > 0 && (
        <div className="diff-foot dim">{t('diff.noLineOpsWs')}</div>
      )}
      {lineSel.length > 0 && interactive && (
        <div className="selbar">
          <span>{t('diff.selectedLines', String(lineSel.length))}</span>
          <span className="spacer" />
          {canDiscard && (
            <Button small danger onClick={() => void applyLines(diff, lineSel, 'discard')}>
              {t('diff.discardLines')}
            </Button>
          )}
          {canStage && (
            <Button small primary onClick={() => void applyLines(diff, lineSel, 'stage')}>
              {t('diff.stageLines')}
            </Button>
          )}
          {canUnstage && (
            <Button small primary onClick={() => void applyLines(diff, lineSel, 'unstage')}>
              {t('diff.unstageLines')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

interface BodyProps {
  diff: FileDiff;
  rows: Row[];
  virtualizer: ReturnType<typeof useVirtualizer<HTMLDivElement, Element>>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  maxChars: number;
  words: (line: DiffLine) => { text: string; changed: boolean }[] | undefined;
  syntax: Map<number, Tok[]> | null;
  selSet: Set<number>;
  interactive: boolean;
  onGutterDown: (e: MouseEvent, line: DiffLine) => void;
  onGutterEnter: (line: DiffLine) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  hunkButtons: (h: DiffHunk) => React.ReactNode;
}

function DiffBody(p: BodyProps) {
  const { diff } = p;
  if (diff.image) {
    return (
      <div className="diff-image">
        <figure>
          <figcaption>{t('diff.before')}</figcaption>
          {diff.image.before ? <img src={diff.image.before} alt={t('diff.before')} /> : <div className="dim">{t('diff.noImage')}</div>}
        </figure>
        <figure>
          <figcaption>{t('diff.after')}</figcaption>
          {diff.image.after ? <img src={diff.image.after} alt={t('diff.after')} /> : <div className="dim">{t('diff.noImage')}</div>}
        </figure>
      </div>
    );
  }
  if (diff.binary) return <Empty icon="file-binary">{t('diff.binary')}</Empty>;
  if (diff.hunks.length === 0) {
    return <Empty icon="check">{diff.fileMode === 'modeChange' ? t('diff.modeChange') : t('diff.noChanges')}</Empty>;
  }
  const items = p.virtualizer.getVirtualItems();
  return (
    <div className={cx('diff-scroll', p.interactive && 'interactive')} ref={p.scrollRef} tabIndex={0} onKeyDown={p.onKeyDown} role="table" aria-label={diff.path}>
      <div style={{ height: p.virtualizer.getTotalSize(), position: 'relative', minWidth: `calc(${p.maxChars}ch + 140px)` }}>
        {items.map((vi) => {
          const row = p.rows[vi.index];
          const style = { transform: `translateY(${vi.start}px)` };
          if (row.kind === 'hunk') {
            return (
              <div key={`h${row.hunk.index}`} className="hk" style={style} role="row">
                <span className="hk-text">{row.hunk.header}</span>
                {p.hunkButtons(row.hunk)}
              </div>
            );
          }
          const l = row.line;
          const segs = l.kind === ' ' ? undefined : p.words(l);
          return (
            <div
              key={`l${l.id}`}
              className={cx('dl', l.kind === '+' && 'add', l.kind === '-' && 'del', p.selSet.has(l.id) && 'pick')}
              style={style}
              role="row"
            >
              <span className="ln" onMouseDown={(e) => p.onGutterDown(e, l)} onMouseEnter={() => p.onGutterEnter(l)}>
                {l.oldNo ?? ''}
              </span>
              <span className="ln" onMouseDown={(e) => p.onGutterDown(e, l)} onMouseEnter={() => p.onGutterEnter(l)}>
                {l.newNo ?? ''}
              </span>
              <span className="sign">{l.kind === ' ' ? '' : l.kind === '-' ? '−' : '+'}</span>
              <span className="code">
                <Code text={l.text} toks={p.syntax?.get(l.id)} words={segs} />
                {l.crlf && <span className="eol" title="CRLF">↵</span>}
                {l.noEol && (
                  <span className="noeol" title={t('diff.noEol')}>
                    <Icon name="circle-slash" />
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The text of one line. Overlays syntax colors (toks) and word-level highlights (words) */
function Code({ text, toks, words }: { text: string; toks: Tok[] | undefined; words: { text: string; changed: boolean }[] | undefined }) {
  if (!toks && !words) return <>{text}</>;
  return (
    <>
      {mergeHighlights(text, toks, words).map((g, i) => {
        const inner = g.pieces.map((pc, j) =>
          pc.color || pc.style ? (
            <span key={j} style={tokenStyle(pc.color, pc.style)}>
              {pc.text}
            </span>
          ) : (
            pc.text
          ),
        );
        return g.changed ? <mark key={i}>{inner}</mark> : <span key={i}>{inner}</span>;
      })}
    </>
  );
}

function tokenStyle(color: string | undefined, style: number | undefined): React.CSSProperties {
  const css: React.CSSProperties = {};
  if (color) css.color = color;
  if (style) {
    if (style & FONT_ITALIC) css.fontStyle = 'italic';
    if (style & FONT_BOLD) css.fontWeight = 'bold';
    const deco = [style & FONT_UNDERLINE && 'underline', style & FONT_STRIKETHROUGH && 'line-through'].filter(Boolean);
    if (deco.length > 0) css.textDecoration = deco.join(' ');
  }
  return css;
}

/** Word-level highlights (diffWordsWithSpace of jsdiff). Computed only for pairs of changed lines */
function useWordDiff(diff: FileDiff) {
  const cache = useRef(new Map<number, { text: string; changed: boolean }[] | null>());
  const pairs = useMemo(() => {
    cache.current = new Map();
    const pair = new Map<number, DiffLine>();
    for (const h of diff.hunks) {
      const ls = h.lines;
      let i = 0;
      while (i < ls.length) {
        if (ls[i].kind !== '-') {
          i++;
          continue;
        }
        const dels: DiffLine[] = [];
        while (i < ls.length && ls[i].kind === '-') dels.push(ls[i++]);
        const adds: DiffLine[] = [];
        while (i < ls.length && ls[i].kind === '+') adds.push(ls[i++]);
        const n = Math.min(dels.length, adds.length);
        for (let k = 0; k < n; k++) {
          pair.set(dels[k].id, adds[k]);
          pair.set(adds[k].id, dels[k]);
        }
      }
    }
    return pair;
  }, [diff]);

  return useCallback(
    (line: DiffLine) => {
      if (cache.current.has(line.id)) return cache.current.get(line.id) ?? undefined;
      const other = pairs.get(line.id);
      let result: { text: string; changed: boolean }[] | null = null;
      if (other && line.text.length < 400 && other.text.length < 400) {
        const [oldText, newText] = line.kind === '-' ? [line.text, other.text] : [other.text, line.text];
        const parts = diffWordsWithSpace(oldText, newText);
        const segs: { text: string; changed: boolean }[] = [];
        let changedChars = 0;
        for (const part of parts) {
          if (line.kind === '-' && part.added) continue;
          if (line.kind === '+' && part.removed) continue;
          const changed = line.kind === '-' ? !!part.removed : !!part.added;
          if (changed) changedChars += part.value.length;
          segs.push({ text: part.value, changed });
        }
        // Do not highlight when almost everything changed (it would be harder to read)
        result = changedChars > 0 && changedChars < line.text.length * 0.8 ? segs : null;
      }
      cache.current.set(line.id, result);
      return result ?? undefined;
    },
    [pairs],
  );
}
