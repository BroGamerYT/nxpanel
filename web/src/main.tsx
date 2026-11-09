import { StrictMode, Suspense, lazy, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { AuthProvider, useAuth } from './lib/auth';
import { Shell } from './components/Shell';
import { Login } from './pages/Login';
import { ServerList } from './pages/ServerList';
// Seiten erst laden, wenn man sie oeffnet. Die Startseite (Serverliste)
// kommt sofort mit; Konsole (xterm), Dateimanager, Admin-Seiten usw. folgen
// beim ersten Aufruf. Vorher lud das Panel ueber 1 MB JavaScript auf einmal.
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));
const ServerPage = page(() => import('./pages/ServerPage'), 'ServerPage');
const CreateServer = page(() => import('./pages/CreateServer'), 'CreateServer');
const About = page(() => import('./pages/About'), 'About');
const Network = page(() => import('./pages/Network'), 'Network');
const Community = page(() => import('./pages/Community'), 'Community');
const AdminUsers = page(() => import('./pages/AdminUsers'), 'AdminUsers');
const AdminAudit = page(() => import('./pages/AdminAudit'), 'AdminAudit');
const GameTestReport = page(() => import('./pages/GameTestReport'), 'GameTestReport');
const Integrations = page(() => import('./pages/Integrations'), 'Integrations');
const AdminFiles = page(() => import('./pages/AdminFiles'), 'AdminFiles');
const Account = page(() => import('./pages/Account'), 'Account');
import { Spinner, Toaster } from './components/ui';
import { useToasts, dismiss } from './lib/toast';
import { I18nProvider, i18nReady, t } from './lib/i18n';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 2_000 } },
});

function App() {
  const { me, ready } = useAuth();
  const toasts = useToasts();
  if (!ready) return <div className="min-h-full grid place-items-center"><Spinner /></div>;
  if (!me) return <Login />;
  return (
    <Suspense fallback={<div className="min-h-full grid place-items-center"><Spinner /></div>}>
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<ServerList />} />
        <Route path="neu" element={<CreateServer />} />
        <Route path="info" element={<About />} />
        <Route path="hilfe" element={<About />} />
        <Route path="docs" element={<About />} />
        <Route path="community" element={<Community />} />
        <Route path="account" element={<Account />} />
        <Route path="server/:id" element={<ServerPage />} />
        {me.permissions['admin.nodes'] && <Route path="netzwerk" element={<Network />} />}
        {me.permissions['admin.users'] && <Route path="admin/users" element={<AdminUsers />} />}
        {me.permissions['admin.audit'] && <Route path="admin/audit" element={<AdminAudit />} />}
        {me.user.role === 'admin' && <Route path="admin/testbericht" element={<GameTestReport />} />}
        {me.user.role === 'admin' && <Route path="admin/integrationen" element={<Integrations />} />}
        {me.user.role === 'admin' && <Route path="admin/dateien" element={<AdminFiles />} />}
        <Route path="*" element={<p className="text-dim">{t('common.notFound')}</p>} />
      </Route>
    </Routes>
    <Toaster toasts={toasts} onDismiss={dismiss} />
    </Suspense>
  );
}

void i18nReady.finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <I18nProvider>
              <App />
            </I18nProvider>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
});
