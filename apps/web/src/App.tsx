import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactElement } from 'react';
import { Spinner } from './components/ui';
import { ROUTES, type AppRoute } from './routes';
import { useSession } from './state/session';
import { TermsGate } from './features/auth/TermsGate';

function Guard({ route }: { route: AppRoute }): ReactElement {
  const { user, loading, context, contextLoading } = useSession();
  const location = useLocation();
  if (route.auth === false) return route.element;
  if (loading) return <Spinner />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.termsRequired) return <TermsGate />;
  if (route.admin && user.role !== 'admin') return <Navigate to="/clubs" replace />;
  if (route.surface) {
    if (!user.activeClubId) return <Navigate to="/clubs" replace />;
    if (contextLoading) return <Spinner />;
    if (!context?.surfaces.includes(route.surface)) return <Navigate to="/clubs" replace />;
  }
  return route.element;
}

export function App() {
  const { user } = useSession();
  return (
    <Routes>
      {ROUTES.map((r) => <Route key={r.path} path={r.path} element={<Guard route={r} />} />)}
      <Route path="*" element={<Navigate to={user ? (user.role === 'admin' ? '/admin' : '/clubs') : '/login'} replace />} />
    </Routes>
  );
}
