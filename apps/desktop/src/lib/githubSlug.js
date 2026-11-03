// githubSlug.js — normaliza una URL o referencia de GitHub a "owner/repo" en
// minúsculas, para poder comparar el remoto `origin` de git contra el
// `github_repo` guardado en un proyecto de Lixbon Team. Devuelve '' si no es
// de github.com (otro host, o algo que no se puede leer como owner/repo).
const HOSTS = new Set(['github.com', 'www.github.com']);
// GitHub: el owner no lleva puntos (así un host como `gitlab.com` no pasa por owner).
const OWNER = /^[a-z0-9-]+$/i;
const REPO = /^[a-z0-9._-]+$/i;

function hostYRuta(s) {
  // scp: git@github.com:owner/repo.git
  const scp = /^[^@/\s]+@([^:/\s]+):(?!\/\/)(.+)$/.exec(s);
  if (scp) return [scp[1], scp[2]];
  // https://, ssh://, git:// (con o sin usuario:token@ y puerto)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return [u.hostname, u.pathname];
    } catch {
      return ['', ''];
    }
  }
  // github.com/owner/repo u "owner/repo" a secas
  const m = /^(?:www\.)?github\.com\/(.*)$/i.exec(s);
  return ['github.com', m ? m[1] : s];
}

export function githubSlug(input) {
  if (!input) return '';
  const [host, ruta] = hostYRuta(String(input).trim());
  if (!HOSTS.has(host.toLowerCase())) return '';
  const [owner, repo] = ruta.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (!owner || !repo || !OWNER.test(owner) || !REPO.test(repo)) return '';
  return `${owner}/${repo}`.toLowerCase();
}
