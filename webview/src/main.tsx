import '@vscode/codicons/dist/codicon.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { App } from './components/App';
import { setLang } from './i18n';
import { RpcClient, devTransport, isVsCode, vscodeTransport } from './rpc/RpcClient';
import { bootstrap, reportError, setRpc } from './store/actions';
import type { Boot } from './store/store';

const bootEl = document.getElementById('twigline-boot');
const boot = JSON.parse(bootEl?.textContent || '{}') as Boot;
if (boot.lang) setLang(boot.lang);

const rpc = new RpcClient(isVsCode() ? vscodeTransport() : devTransport());
setRpc(rpc);

createRoot(document.getElementById('root')!).render(<App />);
bootstrap(boot).catch((e) => reportError(e));
