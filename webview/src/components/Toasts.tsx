import { dismissToast } from '../store/actions';
import { useStore } from '../store/store';
import { cx } from '../util/format';
import { Button, Icon, IconButton } from './ui';
import { t } from '../i18n';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className={cx('toast', x.kind)}>
          <Icon name={x.kind === 'error' ? 'error' : x.kind === 'warning' ? 'warning' : 'info'} />
          <span className="msg">{x.message}</span>
          {x.actions?.map((a) => (
            <Button
              key={a.label}
              small
              onClick={() => {
                dismissToast(x.id);
                a.run();
              }}
            >
              {a.label}
            </Button>
          ))}
          <IconButton icon="close" title={t('close')} onClick={() => dismissToast(x.id)} />
        </div>
      ))}
    </div>
  );
}
