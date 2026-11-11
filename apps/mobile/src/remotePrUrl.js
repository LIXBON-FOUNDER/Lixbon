// Saneado de las URLs de PR que llegan por el canal remoto (LXO-243).
//
// Ningún cliente Remote pinta ni abre una `pr_url` que no cumpla esta allowlist: solo http(s), sin credenciales ni query ni
// fragmento, host y segmentos de ruta válidos, y como mucho 300 caracteres. Es la MISMA regla que el Core
// (`apps/desktop/src-tauri/src/orch/pr_url.rs`) y que `lxo`; los vectores comunes están en
// `docs/core/fixtures/pr_url_allowlist.v1.json` y cada copia los ejecuta. Hay una copia por cliente (web, mobile y desktop): si
// una cambia su regla, cambian las tres, el Core, lxo y el fixture.

export const PR_URL_MAX_LEN = 300;

const HOST = /^[A-Za-z0-9.-]+$/;
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const PORT = /^[0-9]{1,5}$/;

/** La URL pública de un PR, o `null` si no es segura. Nunca recorta a ciegas: lo que no encaja se descarta. */
export function sanitizePrUrl(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  const sep = text.indexOf('://');
  if (sep < 0) return null;
  const scheme = text.slice(0, sep);
  if (scheme !== 'https' && scheme !== 'http') return null;
  let rest = text.slice(sep + 3);
  const cut = rest.search(/[?#]/);
  if (cut >= 0) rest = rest.slice(0, cut);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const authority = rest.slice(0, slash);
  const path = rest.slice(slash);
  const at = authority.lastIndexOf('@');
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  const colon = hostPort.indexOf(':');
  const host = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
  const port = colon >= 0 ? hostPort.slice(colon + 1) : null;
  const hostOk = host.length > 0 && !/^[.-]/.test(host) && !/[.-]$/.test(host) && HOST.test(host);
  const portOk = port === null || PORT.test(port);
  const pathOk = path.slice(1).split('/').every((segment) => segment !== '.' && segment !== '..' && SEGMENT.test(segment));
  if (!(hostOk && portOk && pathOk)) return null;
  const clean = `${scheme}://${hostPort}${path}`;
  return clean.length <= PR_URL_MAX_LEN ? clean : null;
}

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const has = (x, key) => Object.prototype.hasOwnProperty.call(x, key);

/**
 * La snapshot del orquestador con la `pr_url` de cada Task pasada por la allowlist (`null` si no es segura). No muta la entrada y
 * deja intacto todo lo demás.
 *
 * Devuelve `null` —y quien la recibe conserva la que ya tenía— si la snapshot no tiene la forma que se puede recorrer y sanear:
 * no es un objeto, `tasks` o `runs` no son arrays, o alguna Task no es un objeto. Una `pr_url` escondida en una estructura que no
 * se recorre se saltaría la allowlist, así que no se acepta a medias. Tampoco se acepta un `__proto__` propio.
 */
export function sanitizeOrchSnapshot(snapshot) {
  if (!isObject(snapshot) || has(snapshot, '__proto__')) return null;
  if (!Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.runs)) return null;
  const tasks = [];
  for (const task of snapshot.tasks) {
    if (!isObject(task) || has(task, '__proto__')) return null;
    tasks.push(has(task, 'pr_url') ? { ...task, pr_url: sanitizePrUrl(task.pr_url) } : task);
  }
  return { ...snapshot, tasks };
}
