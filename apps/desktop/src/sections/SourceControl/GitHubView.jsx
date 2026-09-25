// GitHubView.jsx — pull requests del repositorio en el modo Git. Con la CLI
// `gh` (y su sesión) hay lista, revisiones, checks y fusión; sin ella queda la
// vista pública del PR de la rama actual.
import { useCallback, useEffect, useState } from 'react';
import { useGitStore } from '../../store/gitStore';
import { useChatStore } from '../../store/chatStore';
import { useWorkbenchStore } from '../../store/workbenchStore';
import { githubSlug } from '../../lib/githubSlug';
import { openExternal } from '../../lib/tauri';
import { showConfirm } from '../../lib/confirm';
import { ghStatus, listPrs, viewPr, reviewComments, mergePr, checkState } from '../../lib/github';
import { Segmented } from '../../components/Segmented';
import { SpinRing } from '../../components/Ring';
import { LogoMark } from '../../components/Logo';
import { IconExternal, IconCheck, IconX, IconPullRequest, IconRefresh } from '../../components/Icons';

const API = 'https://api.github.com';

/** PR de la rama actual con la API pública (sin token; solo repos públicos). */
export function useGithubPr(remoteUrl, branch) {
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
    fetch(`${API}/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=all`, { headers: { Accept: 'application/vnd.github+json' } })
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        if (cancelled) return;
        const found = list[0] || null;
        setPr(found);
        setLoaded(true);
        if (!found) return;
        fetch(`${API}/repos/${owner}/${repo}/commits/${found.head.sha}/check-runs`, { headers: { Accept: 'application/vnd.github+json' } })
          .then((r) => (r.ok ? r.json() : null))
          .then((body) => { if (!cancelled && body) setChecks(body.check_runs || []); })
          .catch(() => {});
      })
      .catch(() => setLoaded(true));
    return () => { cancelled = true; };
  }, [slug, branch]);

  return { pr, checks, loaded, slug };
}

const STATE_LABEL = { OPEN: 'Abierto', CLOSED: 'Cerrado', MERGED: 'Fusionado' };
const REVIEW_LABEL = { APPROVED: 'Aprobó', CHANGES_REQUESTED: 'Pidió cambios', COMMENTED: 'Comentó', DISMISSED: 'Descartada', PENDING: 'Pendiente' };

function stateOf(pr) {
  if (pr.state === 'MERGED' || pr.mergedAt) return 'merged';
  if (pr.state === 'CLOSED') return 'closed';
  return pr.isDraft ? 'draft' : 'open';
}

function askAgent(text) {
  useWorkbenchStore.getState().setMode('agent');
  useChatStore.getState().send(text);
}

function PrDetail({ number, slug, onChanged }) {
  const [pr, setPr] = useState(null);
  const [comments, setComments] = useState([]);
  const [error, setError] = useState('');
  const [merging, setMerging] = useState(false);
  const [method, setMethod] = useState('squash');

  const load = useCallback(async () => {
    setError('');
    try {
      const [p, c] = await Promise.all([viewPr(number), reviewComments(slug, number).catch(() => [])]);
      setPr(p);
      setComments(c);
    } catch (e) {
      setError(String(e.message || e));
    }
  }, [number, slug]);

  useEffect(() => { setPr(null); load(); }, [load]);

  if (error) return <div className="ghd__empty"><span className="scm2__error">{error}</span></div>;
  if (!pr) return <div className="ghd__empty"><SpinRing size={16} /></div>;

  const st = stateOf(pr);
  const checks = (pr.statusCheckRollup || []).map(checkState);
  const running = checks.some((c) => c.state === 'running');
  const failing = checks.filter((c) => c.state === 'fail').length;
  const approvals = (pr.reviews || []).filter((r) => r.state === 'APPROVED').length;
  const byReviewer = new Map();
  for (const r of pr.reviews || []) byReviewer.set(r.author?.login, r.state);
  for (const r of pr.reviewRequests || []) { const n = r.login || r.name; if (n && !byReviewer.has(n)) byReviewer.set(n, 'PENDING'); }
  const threads = comments.filter((c) => !c.replyTo);

  const merge = async () => {
    const { choice } = await showConfirm({
      title: `Fusionar #${pr.number}`,
      message: `${pr.headRefName} → ${pr.baseRefName} con ${method === 'squash' ? 'squash (un solo commit)' : method === 'rebase' ? 'rebase' : 'un commit de merge'}.`,
      options: [{ id: 'yes', label: 'Fusionar', kind: 'primary' }, { id: 'cancel', label: 'Cancelar' }],
    });
    if (choice !== 'yes') return;
    setMerging(true);
    try {
      await mergePr(pr.number, method);
      await load();
      onChanged();
      useGitStore.getState().refresh();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setMerging(false);
    }
  };

  return (
    <div className="ghd scroll">
      <div className="ghd__main">
        <div className="ghd__head rise">
          <span className="ghd__title">{pr.title} <span className="ghd__num">#{pr.number}</span></span>
          <div className="ghd__meta">
            <span className={`ghbadge ghbadge--${st}`}>{st === 'draft' ? 'Borrador' : STATE_LABEL[pr.state] || pr.state}</span>
            <span className="mono">{pr.headRefName} → {pr.baseRefName}</span>
            <span>· {pr.commits?.length || 0} commits · {pr.files?.length || 0} archivos</span>
            <span className="diffstat mono"><em className="is-add">+{pr.additions}</em> <em className="is-del">−{pr.deletions}</em></span>
          </div>
        </div>

        {pr.body?.trim() && <div className="ghd__card ghd__body rise rise--1">{pr.body.trim()}</div>}

        {checks.length > 0 && (
          <div className="ghd__card rise rise--1">
            {checks.map((c, i) => (
              <button key={i} className="ghcheck" onClick={() => c.url && openExternal(c.url)}>
                {c.state === 'running' ? <SpinRing size={12} /> : c.state === 'ok'
                  ? <span className="ghcheck__icon is-ok"><IconCheck size={10} /></span>
                  : <span className="ghcheck__icon is-fail"><IconX size={10} /></span>}
                <span className="ghcheck__name">{c.name}</span>
                <span className="mono ghcheck__time">{c.state === 'running' ? 'en curso' : c.secs != null ? `${c.secs} s` : ''}</span>
              </button>
            ))}
          </div>
        )}

        {threads.map((c) => (
          <div key={c.id} className="ghd__card ghcomment rise rise--2">
            <div className="ghcomment__head">
              <span className="ghavatar">{(c.author || '?').slice(0, 2).toUpperCase()}</span>
              <span><strong>{c.author}</strong> comentó en <span className="mono">{c.path}{c.line ? `:${c.line}` : ''}</span></span>
            </div>
            {c.hunk && <pre className="mono ghcomment__hunk">{c.hunk.split('\n').slice(-3).join('\n')}</pre>}
            <p className="ghcomment__body">{c.body}</p>
            {comments.filter((r) => r.replyTo === c.id).map((r) => (
              <p key={r.id} className="ghcomment__reply"><strong>{r.author}</strong> {r.body}</p>
            ))}
            <div className="ghcomment__acts">
              <button className="lk" onClick={() => openExternal(c.url)}>Responder</button>
              <button className="lk is-accent" onClick={() => askAgent(`Resuelve este comentario de revisión del PR #${pr.number} en ${c.path}${c.line ? `:${c.line}` : ''} (de ${c.author}):\n\n${c.body}`)}>
                <LogoMark size={11} /> Resolver con el agente
              </button>
            </div>
          </div>
        ))}

        {st === 'open' || st === 'draft' ? (
          <div className="ghd__card ghmerge rise rise--3">
            <span className={`ghmerge__icon ${pr.mergeable === 'CONFLICTING' || failing ? 'is-bad' : running ? 'is-wait' : 'is-ok'}`}>
              {running ? <SpinRing size={14} /> : pr.mergeable === 'CONFLICTING' || failing ? <IconX size={14} /> : <IconCheck size={14} />}
            </span>
            <div className="ghmerge__text">
              <span>
                {pr.mergeable === 'CONFLICTING' ? 'Hay conflictos con la rama base'
                  : failing ? `${failing} ${failing === 1 ? 'check falla' : 'checks fallan'}`
                    : running ? 'Listo para fusionar cuando pasen los checks' : 'Listo para fusionar'}
              </span>
              <span className="scm2__muted">{approvals} {approvals === 1 ? 'aprobación' : 'aprobaciones'}{pr.mergeable === 'MERGEABLE' ? ' · sin conflictos' : ''}</span>
            </div>
            <Segmented size="sm" width={64} value={method} onChange={setMethod} options={[{ value: 'squash', label: 'Squash' }, { value: 'merge', label: 'Merge' }, { value: 'rebase', label: 'Rebase' }]} />
            <button className="btn btn--accent" onClick={merge} disabled={merging || pr.isDraft || pr.mergeable === 'CONFLICTING'}>
              {merging && <SpinRing size={12} color="var(--on-accent)" />} Fusionar
            </button>
          </div>
        ) : (
          <div className="ghd__card ghmerge">
            <span className={`ghmerge__icon ${st === 'merged' ? 'is-merged' : ''}`}><IconPullRequest size={14} /></span>
            <span>{st === 'merged' ? `Fusionado en ${pr.baseRefName}` : 'Cerrado sin fusionar'}</span>
          </div>
        )}
      </div>

      <aside className="ghd__side">
        <span className="ssec__label">Revisores</span>
        {byReviewer.size === 0 && <span className="scm2__muted">Nadie todavía</span>}
        {[...byReviewer.entries()].map(([name, state]) => (
          <div key={name} className="ghside__row">
            <span className="ghavatar ghavatar--sm">{(name || '?').slice(0, 2).toUpperCase()}</span>
            <span className="ghside__name">{name}</span>
            <span className={`ghside__state is-${(state || '').toLowerCase()}`}>{REVIEW_LABEL[state] || state}</span>
          </div>
        ))}
        {pr.labels?.length > 0 && (
          <>
            <span className="ssec__label">Etiquetas</span>
            <div className="ghside__labels">{pr.labels.map((l) => <span key={l.name} className="tag">{l.name}</span>)}</div>
          </>
        )}
        {pr.closingIssuesReferences?.length > 0 && (
          <>
            <span className="ssec__label">Cierra</span>
            {pr.closingIssuesReferences.map((i) => (
              <button key={i.number} className="lk ghside__issue" onClick={() => i.url && openExternal(i.url)}>#{i.number}{i.title ? ` ${i.title}` : ''}</button>
            ))}
          </>
        )}
        <div className="ghside__acts">
          <button className="btn btn--ghost" onClick={() => askAgent(`Revisa el pull request #${pr.number} (${pr.headRefName} → ${pr.baseRefName}): «${pr.title}». Mira el diff con \`git diff ${pr.baseRefName}...${pr.headRefName}\` y dime qué problemas, riesgos o mejoras ves antes de fusionarlo.`)}>
            <LogoMark size={12} /> Revisar con el agente
          </button>
          <button className="lk" onClick={() => openExternal(pr.url)}><IconExternal size={12} /> Abrir en GitHub</button>
          <button className="lk" onClick={load}><IconRefresh size={12} /> Actualizar</button>
        </div>
      </aside>
    </div>
  );
}

function PublicView() {
  const { remoteUrl, branch, hasRemote } = useGitStore();
  const { pr, checks, loaded, slug } = useGithubPr(remoteUrl, branch);
  if (!hasRemote) return <div className="ghd__empty">Este repositorio todavía no tiene remoto. Publícalo desde el panel de la izquierda.</div>;
  if (!slug) return <div className="ghd__empty">El remoto de este repositorio no es GitHub.</div>;
  if (!loaded) return <div className="ghd__empty"><SpinRing size={16} /></div>;
  if (!pr) return <div className="ghd__empty">No hay ningún pull request para «{branch}».</div>;
  return (
    <div className="ghd scroll">
      <div className="ghd__main">
        <div className="ghd__head">
          <span className="ghd__title">{pr.title} <span className="ghd__num">#{pr.number}</span></span>
          <div className="ghd__meta"><span className="mono">{pr.head.ref} → {pr.base.ref}</span></div>
        </div>
        {pr.body && <div className="ghd__card ghd__body">{pr.body.slice(0, 1200)}</div>}
        {checks?.length > 0 && (
          <div className="ghd__card">
            {checks.map((c) => (
              <div key={c.id} className="ghcheck">
                <span className={`ghcheck__icon ${c.conclusion === 'success' ? 'is-ok' : 'is-fail'}`}>{c.conclusion === 'success' ? <IconCheck size={10} /> : <IconX size={10} />}</span>
                <span className="ghcheck__name">{c.name}</span>
              </div>
            ))}
          </div>
        )}
        <button className="lk" onClick={() => openExternal(pr.html_url)}><IconExternal size={12} /> Abrir en GitHub</button>
      </div>
    </div>
  );
}

export function GitHubView() {
  const { remoteUrl, branch } = useGitStore();
  const slug = remoteUrl && remoteUrl.includes('github.com') ? githubSlug(remoteUrl) : '';
  const [status, setStatus] = useState(null);
  const [filter, setFilter] = useState('open');
  const [prs, setPrs] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { ghStatus().then(setStatus); }, []);

  const loadList = useCallback(async () => {
    setError('');
    try {
      const list = await listPrs(filter);
      setPrs(list);
      setSelected((cur) => (list.some((p) => p.number === cur) ? cur : (list.find((p) => p.headRefName === branch) || list[0])?.number ?? null));
    } catch (e) {
      setError(String(e.message || e));
      setPrs([]);
    }
  }, [filter, branch]);

  useEffect(() => { if (status === 'ok' && slug) loadList(); }, [status, slug, loadList]);

  if (status === null) return <div className="ghd__empty"><SpinRing size={16} /></div>;
  if (status !== 'ok' || !slug) {
    return (
      <div className="ghwrap">
        {slug && (
          <div className="ghnotice">
            {status === 'missing'
              ? <>Instala <button className="lk is-accent" onClick={() => openExternal('https://cli.github.com')}>GitHub CLI</button> e inicia sesión con <code>gh auth login</code> para ver revisiones, checks y fusionar desde aquí.</>
              : <>Inicia sesión en GitHub CLI con <code>gh auth login</code> en el terminal para ver revisiones y fusionar desde aquí.</>}
          </div>
        )}
        <PublicView />
      </div>
    );
  }

  return (
    <div className="ghlayout">
      <div className="ghlist">
        <div className="ghlist__bar">
          <Segmented size="sm" width={72} value={filter} onChange={setFilter} options={[{ value: 'open', label: 'Abiertos' }, { value: 'closed', label: 'Cerrados' }]} />
        </div>
        {error && <span className="scm2__error ghlist__pad">{error}</span>}
        {prs === null && <span className="skeleton ghlist__skeleton" />}
        {prs?.length === 0 && !error && <span className="scm2__muted ghlist__pad">No hay pull requests {filter === 'open' ? 'abiertos' : 'cerrados'}.</span>}
        {prs?.map((p, i) => {
          const st = stateOf(p);
          return (
            <button key={p.number} className={`ghitem ${selected === p.number ? 'is-active' : ''}`} style={{ animationDelay: `${i * 25}ms` }} onClick={() => setSelected(p.number)}>
              <span className={`ghitem__icon ghitem__icon--${st}`}><IconPullRequest size={13} /></span>
              <span className="ghitem__text">
                <span className="ghitem__title">{p.title}</span>
                <span className="scm2__muted">#{p.number} · {p.author?.login}{p.reviewDecision === 'APPROVED' ? ' · aprobado' : p.reviewDecision === 'CHANGES_REQUESTED' ? ' · cambios pedidos' : ''}</span>
              </span>
            </button>
          );
        })}
      </div>
      {selected ? <PrDetail key={selected} number={selected} slug={slug} onChanged={loadList} /> : <div className="ghd__empty">Elige un pull request.</div>}
    </div>
  );
}
