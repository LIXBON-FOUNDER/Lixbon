// githubSlug.js — normaliza una URL o referencia de GitHub a "owner/repo" en
// minúsculas, para poder comparar el remoto `origin` de git contra el
// `github_repo` guardado en un proyecto de Lixbon Team.
export function githubSlug(input) {
  if (!input) return '';
  let s = String(input).trim();
  s = s.replace(/^git@github\.com:/i, '');
  s = s.replace(/^(https?:\/\/|git:\/\/)?(www\.)?github\.com\//i, '');
  s = s.replace(/\.git$/i, '');
  s = s.replace(/^\/+|\/+$/g, '');
  const [owner, repo] = s.split('/').filter(Boolean);
  if (!owner || !repo) return '';
  return `${owner}/${repo}`.toLowerCase();
}
