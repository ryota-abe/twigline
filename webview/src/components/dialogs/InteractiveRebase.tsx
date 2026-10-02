import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEffect, useState } from 'react';
import type { Operation, RebaseCommit, TodoAction } from '../../../../shared/protocol';
import { t } from '../../i18n';
import { closeDialog, getRpc, runOp } from '../../store/actions';
import { get } from '../../store/store';
import { cx, shortSha } from '../../util/format';
import { Empty, IconButton, Select, Spinner } from '../ui';
import { DialogShell, Warning } from './Dialog';

// Interactive rebase: reordering, pick / reword / edit / squash / fixup / drop, and message editing

interface Item extends RebaseCommit {
  action: TodoAction;
  newMessage?: string;
}

const ACTIONS: TodoAction[] = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];

export function InteractiveRebaseDialog({ base }: { base: string | null }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  useEffect(() => {
    getRpc()
      .request('rebase/commits', { repo: get().boot.repo, base })
      .then(
        (list) => setItems(list.map((c) => ({ ...c, action: 'pick' as TodoAction }))),
        (e) => setError(e instanceof Error ? e.message : String(e)),
      );
  }, [base]);

  const valid = !!items && items.length > 0 && items.some((i) => i.action !== 'drop') && items[0].action !== 'squash' && items[0].action !== 'fixup';
  const op: Operation | null =
    items && valid
      ? {
          kind: 'rebase/interactive',
          base,
          todo: items.map((i) => ({
            action: i.action,
            sha: i.sha,
            subject: i.subject,
            message: (i.action === 'reword' || i.action === 'squash') && i.newMessage?.trim() ? i.newMessage : undefined,
          })),
        }
      : null;

  const onDragEnd = (e: DragEndEvent) => {
    if (!items || !e.over || e.active.id === e.over.id) return;
    const from = items.findIndex((i) => i.sha === e.active.id);
    const to = items.findIndex((i) => i.sha === e.over!.id);
    setItems(arrayMove(items, from, to));
  };
  const update = (sha: string, patch: Partial<Item>) => setItems((cur) => cur && cur.map((i) => (i.sha === sha ? { ...i, ...patch } : i)));
  const move = (index: number, delta: number) => setItems((cur) => (cur ? arrayMove(cur, index, Math.min(cur.length - 1, Math.max(0, index + delta))) : cur));

  return (
    <DialogShell
      title={t('irebase.title', base ? shortSha(base) : t('irebase.root'))}
      wide
      okLabel={t('irebase.ok')}
      okDisabled={!op}
      preview={op}
      onOk={async () => {
        closeDialog();
        if (op) await runOp(op, { success: t('irebase.done') });
      }}
    >
      {error && <Warning danger>{error}</Warning>}
      {!items && !error && (
        <Empty>
          <Spinner />
        </Empty>
      )}
      {items && items.length === 0 && <Empty icon="info">{t('irebase.empty')}</Empty>}
      {items && items.length > 0 && (
        <>
          <p className="dim">{t('irebase.help')}</p>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={items.map((i) => i.sha)} strategy={verticalListSortingStrategy}>
              <div className="irebase-list" role="list">
                {items.map((item, index) => (
                  <SortableRow
                    key={item.sha}
                    item={item}
                    expanded={expanded === item.sha}
                    onToggle={() => setExpanded(expanded === item.sha ? null : item.sha)}
                    onAction={(action) => {
                      update(item.sha, { action, newMessage: action === 'reword' && item.newMessage === undefined ? item.message : item.newMessage });
                      if (action === 'reword' || action === 'squash') setExpanded(item.sha);
                    }}
                    onMessage={(m) => update(item.sha, { newMessage: m })}
                    onMove={(d) => move(index, d)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
          {items[0] && (items[0].action === 'squash' || items[0].action === 'fixup') && <Warning danger>{t('irebase.firstSquash')}</Warning>}
          {items.some((i) => i.action === 'squash' && !i.newMessage?.trim()) && <p className="dim">{t('irebase.squashLater')}</p>}
        </>
      )}
    </DialogShell>
  );
}

function SortableRow({
  item,
  expanded,
  onToggle,
  onAction,
  onMessage,
  onMove,
}: {
  item: Item;
  expanded: boolean;
  onToggle: () => void;
  onAction: (a: TodoAction) => void;
  onMessage: (m: string) => void;
  onMove: (delta: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.sha });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const editable = item.action === 'reword' || item.action === 'squash';
  return (
    <div ref={setNodeRef} style={style} className={cx('irebase-row', isDragging && 'dragging', item.action === 'drop' && 'dropped')} role="listitem">
      <div className="irebase-main">
        <span className="drag-handle" {...attributes} {...listeners} title={t('irebase.drag')}>
          ⠿
        </span>
        <Select value={item.action} onChange={onAction} options={ACTIONS.map((a) => ({ value: a, label: t(`irebase.action.${a}`) }))} />
        <span className="mono dim">{shortSha(item.sha)}</span>
        <span className="subject" title={item.message}>
          {item.action === 'reword' && item.newMessage ? item.newMessage.split('\n')[0] : item.subject}
        </span>
        <IconButton icon="arrow-up" title={t('irebase.up')} onClick={() => onMove(-1)} />
        <IconButton icon="arrow-down" title={t('irebase.down')} onClick={() => onMove(1)} />
        {editable && <IconButton icon={expanded ? 'chevron-up' : 'edit'} title={t('irebase.editMessage')} onClick={onToggle} />}
      </div>
      {editable && expanded && (
        <textarea
          className="input textarea"
          rows={4}
          value={item.newMessage ?? ''}
          placeholder={item.action === 'squash' ? t('irebase.squashPlaceholder') : ''}
          onChange={(e) => onMessage(e.target.value)}
        />
      )}
    </div>
  );
}
