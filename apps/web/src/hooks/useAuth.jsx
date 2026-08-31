// useAuth.jsx — contexto de sesión. Hidrata con /api/auth/me (cookie lixbon_session).
import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // Si el correo de verificación llegó a salir en este registro: null mientras
  // no haya habido uno. El backend puede decir que NO salió (Brevo caído, mal
  // configurado), y callárselo dejaría al recién registrado esperando un correo
  // que nadie envió.
  const [verificationSent, setVerificationSent] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/api/auth/me')
      .then((res) => { if (!cancelled) setUser(res.data.user); })
      .catch(() => { if (!cancelled) setUser(null); })
      .finally(() => { if (!cancelled) setLoading(false); });

    const onUnauthorized = () => setUser(null);
    window.addEventListener('auth:unauthorized', onUnauthorized);
    return () => {
      cancelled = true;
      window.removeEventListener('auth:unauthorized', onUnauthorized);
    };
  }, []);

  const login = useCallback(async (email, password) => {
    const res = await api.post('/api/auth/login', { email, password });
    setUser(res.data.user);
    // /me añade plan_id/plan_name (login no los trae)
    api.get('/api/auth/me').then((me) => setUser(me.data.user)).catch(() => {});
    return res.data;
  }, []);

  const register = useCallback(async ({ firstName, lastName, email, password }) => {
    const res = await api.post('/api/auth/register', {
      first_name: firstName,
      last_name: lastName,
      email,
      password,
    });
    setUser(res.data.user);
    setVerificationSent(res.data.verification_email_sent !== false);
    return res.data;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } catch { /* la cookie se borra igual */ }
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, setUser, loading, login, register, logout, verificationSent }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
