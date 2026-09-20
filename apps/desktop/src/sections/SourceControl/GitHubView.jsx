// GitHubView.jsx — panel central cuando el nav activo es "Git y GitHub": el PR
// abierto de la rama actual (API pública de GitHub, sin token — funciona en
// repos públicos; en privados o sin PR se muestra el estado correspondiente).
import { useEffect, useState } from 'react';
import { useGitStore } from '../../store/gitStore';
import { githubSlug } from '../../lib/githubSlug';
import { openExternal } from '../../lib/tauri';
import { IconExternal, IconCheck } from '../../components/Icons';

const API = 'https://api.github.com';

function useGithubPr(remoteUrl, branch) {
  const [pr, setPr] = useState(null);
  const [checks, setChecks] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const slug = remoteUrl && remoteUrl.includes('github.com') ? githubSlug(remoteUrl) : '';

  useEffect(() => {
    setPr(null);
    setChecks(null);
    setLoaded(false);
    if (!slug || !branch) { setLoaded(true); return undefined; }
    const [owner, repo] = slug.split('/');
    let cancelled = false;

    fetch(`${API}/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=all`, {
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        if (cancelled) return;
        const found = list[0] || null;
        setPr(found);
        setLoaded(true);
        if (!found) return;
        fetch(`${API}/repos/${owner}/${repo}/commits/${found.head.sha}/check-runs`, {
          headers: { Accept: 'application/vnd.github+json' },
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((body) => {
            if (cancelled || !body) return;
            setChecks(body.check_runs || []);
          })
          .catch(() => {});
      })
      .catch(() => setLoaded(true));

    return () => { cancelled = true; };
  }, [slug, branch]);

  return { pr, checks, loaded, slug };
}

export function GitHubView() {
  const { remoteUrl, branch, hasRemote } = useGitStore();
  const { pr, checks, loaded, slug } = useGithubPr(remoteUrl, branch);

  return (
    <div className="ghview">
      <div className="ghview__scroll">
        <div className="ghview__inner">
          <div className="ghview__crumb">
            <IconExternal size={13} />
            GitHub{slug ? ` · ${slug}` : ''}
          </div>

          {!hasRemote ? (
            <div className="ghview__empty">
              <p>Este repositorio todavía no tiene un remoto en GitHub.</p>
              <p className="ghview__empty-hint">Publícalo desde el panel Git del sidebar para ver aquí sus pull requests.</p>
            </div>
          ) : !slug ? (
            <div className="ghview__empty">
              <p>El remoto de este repositorio no es GitHub.</p>
            </div>
          ) : !loaded ? (
            <span className="skeleton" style={{ height: 220, borderRadius: 18, display: 'block' }} />
          ) : !pr ? (
            <div className="ghview__empty">
              <p>No hay ningún pull request para «{branch}».</p>
              <p className="ghview__empty-hint">Cuando abras uno en GitHub, aparecerá aquí con sus checks.</p>
            </div>
          ) : (
            <div className="ghview__pr">
              <div className="ghview__pr-head">
                <span className="ghview__pr-title">{pr.title}</span>
                <span className={`ghview__pr-badge ${pr.state === 'closed' ? (pr.merged_at ? 'is-merged' : 'is-closed') : pr.draft ? 'is-draft' : ''}`}>
                  {pr.state === 'closed' ? (pr.merged_at ? 'Fusionado' : 'Cerrado') : pr.draft ? 'Borrador' : 'Abierto'}
                </span>
              </div>
              <span className="ghview__pr-meta">#{pr.number} · {pr.head.ref} → {pr.base.ref}</span>
              {pr.body && <p className="ghview__pr-desc">{pr.body.slice(0, 400)}</p>}

              {checks && checks.length > 0 && (
                <div className="ghview__checks">
                  {checks.map((c) => (
                    <div className="ghview__checkrow" key={c.id}>
                      <span className={`ghview__checkicon ${c.conclusion === 'success' ? 'is-ok' : c.conclusion ? 'is-fail' : 'is-pending'}`}>
                        {c.conclusion === 'success' && <IconCheck size={11} />}
                      </span>
                      <span className="ghview__checkname">{c.name}</span>
                      {c.completed_at && c.started_at && (
                        <span className="ghview__checktime">
                          {Math.max(1, Math.round((new Date(c.completed_at) - new Date(c.started_at)) / 1000))}s
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {checks && checks.length > 0 && (
                <div className="ghview__checksum">
                  <IconCheck size={14} />
                  <span>{checks.filter((c) => c.conclusion === 'success').length} de {checks.length} checks pasando</span>
                </div>
              )}

              <button className="ghview__link" onClick={() => openExternal(pr.html_url)}>Ver en GitHub</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
