export const DESKTOP_LINK_CAPABILITY = 'core_desktop_link';
export function preparedDesktopLink(previous, state) {
  return state.value ?? (state.code === 'offline' ? previous : null);
}
export const DESKTOP_LINK_MESSAGES = {
  opened: 'Destino abierto en el Desktop conectado.', unavailable: 'Desktop no pudo abrirse. Puedes copiar o compartir el enlace.',
  stale: 'La revisión del enlace está obsoleta. Revisa el destino en Desktop antes de continuar.',
  link_stale: 'Esta Attention o revisión ya no está vigente. Actualiza la pantalla.',
  link_not_found: 'El destino ya no está disponible en Core.', link_target_mismatch: 'El destino cambió; actualiza la pantalla.',
  link_host_unavailable: 'El workspace está en un host no disponible.', link_unauthorized: 'Core no autorizó este enlace.',
  unauthorized: 'Vuelve a iniciar sesión.', unsupported_action: 'Actualiza Desktop para abrir estos enlaces.',
  offline: 'El host está desconectado. Un enlace ya preparado se puede copiar o compartir.',
  invalid_response: 'El host devolvió un enlace que no se pudo verificar.', not_requested: 'Enlace preparado para Desktop.',
};

const id = (v) => typeof v === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(v);
const safeFile = (v) => typeof v === 'string' && v.length <= 1024 && !/[\\:%\u0000-\u001f\u007f]/.test(v)
  && v.split('/').every((p) => p && p !== '.' && p !== '..');

/** Accept only the canonical Core URL; credentials, unknown query fields and absolute paths never reach copy/share. */
export function verifiedDesktopLink(data, source) {
  const r = data?.link, t = r?.target;
  if (r?.v !== 1 || !['ready', 'stale'].includes(r.status) || typeof r.canonical !== 'string' || r.canonical.length > 2048
    || !id(t?.project_id) || (t.task_id != null && !id(t.task_id)) || (t.attempt_id != null && (!id(t.attempt_id) || !t.task_id))
    || (source.attempt_id && t.attempt_id !== source.attempt_id) || (source.task_id && t.task_id !== source.task_id)
    || (source.project_id && t.project_id !== source.project_id)
    || (t.file != null && !safeFile(t.file)) || (t.line != null && (!t.file || !Number.isSafeInteger(t.line) || t.line < 1 || t.line > 10000000))
    || (t.revision != null && !/^[a-f0-9]{7,64}$/i.test(t.revision))
    || !['opened', 'unavailable', 'stale', 'not_requested'].includes(data.open_status)
    || (r.status === 'stale' && data.open_status === 'opened')) return null;
  try {
    const u = new URL(r.canonical);
    const path = `/` + t.project_id + (t.task_id ? `/task/${t.task_id}` : '') + (t.attempt_id ? `/attempt/${t.attempt_id}` : '');
    if (u.protocol !== 'lixbon:' || u.hostname !== 'project' || u.username || u.password || u.port || u.hash || u.pathname !== path) return null;
    const keys = [...u.searchParams.keys()];
    if (new Set(keys).size !== keys.length || keys.some((k) => !['view', 'file', 'line', 'revision', 'v'].includes(k))) return null;
    if (u.searchParams.has('v') && u.searchParams.get('v') !== '1') return null;
    for (const k of ['view', 'file', 'line', 'revision']) if (u.searchParams.get(k) !== (t[k] == null ? null : String(t[k]))) return null;
    if (t.view != null && !['overview', 'activity', 'diff', 'review', 'artifact'].includes(t.view)) return null;
    if (['review', 'diff', 'artifact'].includes(t.view) && !t.attempt_id) return null;
    if (source.view && t.view !== source.view) return null;
    for (const k of ['file', 'line', 'revision']) if (source[k] != null && String(t[k]) !== String(source[k])) return null;
    return { url: r.canonical, status: data.open_status, target: t, revision: r.revision };
  } catch { return null; }
}

// A generation token prevents an old host, target or navigation response from replacing the current link.
export function createDesktopLinkController({ request, publish }) {
  let generation = 0;
  return {
    invalidate() { generation++; },
    async prepare(source, open = true) {
      const mine = ++generation;
      const res = await request(DESKTOP_LINK_CAPABILITY, { ...source, open_desktop: open });
      if (mine !== generation) return null;
      const value = res.ok ? verifiedDesktopLink(res.data, source) : null;
      const state = value ? { value, code: value.status } : { value: null, code: res.code || (res.ok ? 'invalid_response' : 'offline') };
      publish(state);
      return state;
    },
  };
}
