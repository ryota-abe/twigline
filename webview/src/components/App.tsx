import { useEffect } from 'react';
import { t } from '../i18n';
import { focusSearch, refreshAll, setView } from '../store/actions';
import { useStore } from '../store/store';
import { SequenceBanner } from './Banner';
import { DevContextMenu } from './DevContextMenu';
import { Dialogs } from './dialogs/Dialogs';
import { FileStatus } from './FileStatus';
import { Header } from './Header';
import { History } from './History';
import { Toasts } from './Toasts';
import { Empty, Spinner } from './ui';

// The top level is the "Uncommitted Changes | History" tab. Lists of branches and so on are only inside the History tab (History.tsx)

export function App() {
  const view = useStore((s) => s.view);
  const ready = useStore((s) => s.booted && !!s.snapshot && !!s.init);
  const dev = useStore((s) => !!s.boot.dev);

  useEffect(() => {
    // Keys inside the panel (so the same actions work in the development browser, where VS Code keybindings do not reach)
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!dev || !mod || useStore.getState().dialog) return;
      if (e.shiftKey && e.code === 'Digit1') setView('fileStatus');
      else if (e.shiftKey && e.code === 'Digit2') setView('history');
      else if (e.shiftKey && e.code === 'KeyR') void refreshAll();
      else if (!e.shiftKey && e.code === 'KeyF') focusSearch();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dev]);

  if (!ready) {
    return (
      <div className="app loading">
        <Empty>
          <Spinner /> {t('loading')}
        </Empty>
        <Dialogs />
        <Toasts />
      </div>
    );
  }

  return (
    <div className="app">
      <Header />
      <SequenceBanner />
      <main className="app-main">{view === 'fileStatus' ? <FileStatus /> : <History />}</main>
      <Dialogs />
      <Toasts />
      {dev && <DevContextMenu />}
    </div>
  );
}
