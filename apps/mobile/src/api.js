// api.js — cliente HTTP del gateway. Mismo criterio que la web (lib/api.js):
// errores normalizados desde `detail` (string u objeto {code, message}) y
// logout automático en 401. Auth por Bearer API key.

export class ApiException extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'ApiException';
    this.status = status;
  }
}

/// `detail` del gateway: string plano o, en cuotas (F5), {code, message, …}.
export function extractDetail(data, statusCode) {
  if (data && typeof data === 'object') {
    const detail = data.detail;
    if (typeof detail === 'string' && detail) return detail;
    if (detail && typeof detail.message === 'string') return detail.message;
  }
  return `Error del servidor (${statusCode})`;
}

export class ApiClient {
  constructor({ getBase, getToken, onUnauthorized }) {
    this.getBase = getBase;
    this.getToken = getToken;
    this.onUnauthorized = onUnauthorized || null;
  }

  get base() {
    return this.getBase().replace(/\/+$/, '');
  }

  async request(path, { method = 'GET', body = null, auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const token = this.getToken();
    if (auth && token) headers.Authorization = `Bearer ${token}`;

    let res;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiException('Sin conexión con el servidor');
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      // respuesta sin cuerpo JSON
    }

    if (res.status >= 400) {
      if (res.status === 401 && auth && token && this.onUnauthorized) {
        this.onUnauthorized();
      }
      throw new ApiException(extractDetail(data, res.status), res.status);
    }
    return data;
  }

  get(path, opts = {}) {
    return this.request(path, { ...opts });
  }

  post(path, body = null, opts = {}) {
    return this.request(path, { method: 'POST', body, ...opts });
  }

  patch(path, body = null) {
    return this.request(path, { method: 'PATCH', body });
  }

  delete(path, body = null) {
    return this.request(path, { method: 'DELETE', body });
  }
}
