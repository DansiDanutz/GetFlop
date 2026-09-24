import type { AppRoute } from '../../routes';
import { ForgotPin } from './ForgotPin';
import { Login } from './Login';
import { Register } from './Register';

export const authRoutes: AppRoute[] = [
  { path: '/login', element: <Login />, auth: false },
  { path: '/register', element: <Register />, auth: false },
  { path: '/forgot-pin', element: <ForgotPin />, auth: false },
];
