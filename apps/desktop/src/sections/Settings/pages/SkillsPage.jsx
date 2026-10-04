// SkillsPage.jsx — Ajustes → Skills: catálogo oficial de Lixbon (/adversary,
// /marketing-lxo…). Cada tarjeta abre su ficha; desde ahí se instala en los
// agentes elegidos, se actualiza, se desinstala y se califica.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { api } from '../../../lib/api';
import { showConfirm } from '../../../lib/confirm';
import { useAppStore } from '../../../store/appStore';
import { ChatMarkdown } from '../../../chat/ChatMarkdown';
import { Modal } from '../../../components/Modal';
import { SpinRing } from '../../../components/Ring';
import { PageHead, SectionHead } from '../SettingsParts';
import { IconBook, IconDownload, IconExternal, IconRefresh, IconTrash } from '../../../components/Icons';

const fecha = (iso) => (iso ? new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const peso = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function newer(a, b) {
  const pa = (a || '0').split('.').map(Number);
  const pb = (b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Estado de una skill en este equipo: dónde está y si alguna copia es más vieja. */
function estadoDe(skill, installed) {
  const here = installed?.[skill.slug] || [];
  const ours = here.filter((i) => !i.external);
  return {
    here,
    agents: here.map((i) => i.agent),
    outdated: ours.some((i) => newer(skill.version, i.version)),
    version: ours[0]?.version || null,
    external: here.length > 0 && ours.length === 0,
  };
}

function Stars({ value }) {
  const v = Math.round((value || 0) * 2) / 2;
  return (
    <span className="skl-stars" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((i) => <span key={i} className={v >= i ? 'is-on' : v >= i - 0.5 ? 'is-half' : ''}>★</span>)}
    </span>
  );
}

function Rating({ skill }) {
  if (!skill.rating_count) return <span className="skl-muted">Sin votos todavía</span>;
  return (
    <span className="skl-rating" title={skill.rating_avg.toFixed(2)}>
      <Stars value={skill.rating_avg} /> <b>{skill.rating_avg.toFixed(1)}</b>
      <span className="skl-muted">({skill.rating_count})</span>
    </span>
  );
}

function Badge({ estado }) {
  if (estado.outdated) return <span className="orch__pill is-warn">Actualización</span>;
  if (estado.external) return <span className="orch__pill">Instalada aparte</span>;
  if (estado.agents.length) return <span className="orch__pill is-ok">Instalada</span>;
  return null;
}

function Vote({ skill, onRated }) {
  const [hover, setHover] = useState(0);
  const [error, setError] = useState('');
  const votar = async (stars) => {
    setError('');
    try {
      const stats = stars
        ? await api.put(`/api/skills/${skill.slug}/rating`, { stars })
        : await api.delete(`/api/skills/${skill.slug}/rating`);
      onRated(stats);
    } catch (e) {
      setError(e.message);
    }
  };
  if (!skill.installed_by_me && !skill.my_rating) {
    return <span className="srow__hint">Instálala para poder calificarla.</span>;
  }
  const actual = hover || skill.my_rating || 0;
  return (
    <div className="skl-vote">
      <div className="skl-vote__stars" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((i) => (
          <button key={i} type="button" className={actual >= i ? 'is-on' : ''} aria-label={`${i} de 5`}
            onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(0)}
            onClick={() => votar(i)}>★</button>
        ))}
      </div>
      {skill.my_rating && <button type="button" className="lk" onClick={() => votar(null)}>Quitar voto</button>}
      {error && <span className="skl-error">{error}</span>}
    </div>
  );
}

function Detail({ slug, agents, installed, onClose, onChanged }) {
  const { serverUrl, apiKey } = useAppStore();
  const [skill, setSkill] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const estado = skill ? estadoDe(skill, installed) : null;
  const [chosen, setChosen] = useState(null);

  const load = useCallback(() => api.get(`/api/skills/${slug}`).then(setSkill).catch((e) => setError(e.message)), [slug]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!skill || chosen) return;
    const there = estadoDe(skill, installed).agents;
    setChosen(there.length ? there : agents.filter((a) => a.detected).map((a) => a.id).slice(0, 1));
  }, [skill, installed, agents, chosen]);

  const toggle = (id) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const labels = (ids) => ids.map((id) => agents.find((a) => a.id === id)?.label || id).join(', ');

  const install = async () => {
    const { choice } = await showConfirm({
      title: `Instalar /${skill.slug} ${skill.version}`,
      message: `Se copiará en: ${labels(chosen)}.\nEl paquete se verifica con su SHA-256 (${skill.sha256.slice(0, 12)}…) antes de escribir nada. Reinicia el agente para que la vea.`,
      options: [{ id: 'ok', label: 'Instalar', kind: 'primary' }, { id: 'cancel', label: 'Cancelar' }],
    });
    if (choice !== 'ok') return;
    setBusy('install');
    setError('');
    try {
      const res = await fetch(`${serverUrl}/api/skills/${skill.slug}/download?client=ide&version=${encodeURIComponent(skill.version)}`, {
        headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(res.status === 401 ? 'Inicia sesión en Lixbon para instalar skills.' : `Descarga fallida (${res.status})`);
      const sha = res.headers.get('x-skill-sha256');
      if (sha !== skill.sha256) throw new Error('La firma del paquete no coincide con la del catálogo: instalación cancelada.');
      const args = { slug: skill.slug, version: skill.version, sha256: sha, packageB64: toBase64(await res.arrayBuffer()), agents: chosen };
      try {
        await invoke('skill_install', { ...args, force: false });
      } catch (e) {
        const msg = String(e);
        if (!msg.startsWith('exists:')) throw e;
        const { choice: c } = await showConfirm({
          title: 'Ya hay una skill con ese nombre',
          message: `${msg.slice(7)} tiene una carpeta «${skill.slug}» que no instaló Lixbon. ¿Reemplazarla?`,
          options: [{ id: 'ok', label: 'Reemplazar', kind: 'danger' }, { id: 'cancel', label: 'Cancelar' }],
        });
        if (c !== 'ok') return;
        await invoke('skill_install', { ...args, force: true });
      }
      await onChanged();
      await load();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy('');
    }
  };

  const uninstall = async () => {
    const { choice } = await showConfirm({
      title: `Desinstalar /${skill.slug}`,
      message: `Se borrará de: ${labels(estado.agents)}.`,
      options: [{ id: 'ok', label: 'Desinstalar', kind: 'danger' }, { id: 'cancel', label: 'Cancelar' }],
    });
    if (choice !== 'ok') return;
    setBusy('uninstall');
    try {
      await invoke('skill_uninstall', { slug: skill.slug, agents: estado.agents });
      await onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy('');
    }
  };

  if (!skill) {
    return (
      <Modal title={`/${slug}`} onClose={onClose} size="lg">
        {error ? <span className="skl-error">{error}</span> : <SpinRing size={18} />}
      </Modal>
    );
  }
  const pending = chosen?.filter((id) => !estado.agents.includes(id)) || [];
  const action = estado.outdated ? 'Actualizar' : pending.length && estado.agents.length ? 'Instalar también aquí' : 'Instalar';
  return (
    <Modal title={skill.title} subtitle={skill.summary} onClose={onClose} size="lg">
      <div className="skl-detail">
        <div className="skl-detail__meta">
          <span className="mono skl-cmd">{skill.command}</span>
          <Rating skill={skill} />
          <span>Versión <b className="mono">{skill.version}</b></span>
          <span>{fecha(skill.released_at)}</span>
          <span>{skill.installs} {skill.installs === 1 ? 'instalación' : 'instalaciones'}</span>
        </div>

        <div className="skl-detail__grid">
          <div className="skl-detail__body">
            <ChatMarkdown>{skill.description_md || skill.summary}</ChatMarkdown>
          </div>
          <aside className="skl-detail__side">
            <section className="skl-box">
              <span className="ssec__label">Instalar en</span>
              {agents.map((a) => {
                const inst = estado.here.find((i) => i.agent === a.id);
                return (
                  <label key={a.id} className={`skl-agent ${a.detected ? '' : 'is-off'}`} title={a.dir}>
                    <input type="checkbox" checked={!!chosen?.includes(a.id)} onChange={() => toggle(a.id)} />
                    <span>{a.label}</span>
                    {inst && <span className="skl-muted mono">{inst.external ? 'aparte' : `v${inst.version}`}</span>}
                  </label>
                );
              })}
              {estado.external && <span className="srow__hint">Hay una copia instalada fuera del catálogo (por el orquestador o a mano).</span>}
              <div className="skl-actions">
                <button className="btn btn--primary btn--sm" disabled={!!busy || !chosen?.length || (!estado.outdated && !pending.length)} onClick={install}>
                  {busy === 'install' ? <SpinRing size={12} /> : estado.outdated ? <IconRefresh size={13} /> : <IconDownload size={13} />} {action}
                </button>
                {estado.agents.length > 0 && (
                  <button className="btn btn--ghost btn--sm" disabled={!!busy} onClick={uninstall}><IconTrash size={13} /> Desinstalar</button>
                )}
              </div>
              {error && <span className="skl-error">{error}</span>}
            </section>
            <section className="skl-box">
              <span className="ssec__label">Tu calificación</span>
              <Vote skill={skill} onRated={(stats) => { setSkill((s) => ({ ...s, ...stats })); onChanged(); }} />
            </section>
            <section className="skl-box">
              <span className="ssec__label">Versiones</span>
              {skill.versions.map((v) => (
                <div key={v.version} className="skl-ver">
                  <span className="mono">v{v.version}</span> <span className="skl-muted">{fecha(v.released_at)}</span>
                  {v.changelog && <p>{v.changelog}</p>}
                </div>
              ))}
            </section>
            <section className="skl-box">
              <span className="ssec__label">Contenido · {peso(skill.size)}</span>
              {skill.files.map((f) => <div key={f.path} className="skl-file"><span className="mono">{f.path}</span><span className="skl-muted">{peso(f.size)}</span></div>)}
              <span className="mono skl-sha" title="SHA-256 del paquete">{skill.sha256}</span>
            </section>
          </aside>
        </div>
      </div>
    </Modal>
  );
}

export function SkillsPage() {
  const serverUrl = useAppStore((s) => s.serverUrl);
  const [skills, setSkills] = useState(null);
  const [agents, setAgents] = useState([]);
  const [installed, setInstalled] = useState({});
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);

  const refreshInstalled = useCallback(async (list) => {
    const slugs = (list || []).map((s) => s.slug);
    setInstalled(slugs.length ? await invoke('skills_installed', { slugs }).catch(() => ({})) : {});
  }, []);

  const load = useCallback(async () => {
    setError('');
    invoke('skills_agents').then(setAgents).catch(() => setAgents([]));
    try {
      const { skills: list } = await api.get('/api/skills');
      setSkills(list);
      await refreshInstalled(list);
    } catch (e) {
      setSkills([]);
      setError(e.message);
    }
  }, [refreshInstalled]);

  useEffect(() => { load(); }, [load]);
  const updates = useMemo(() => (skills || []).filter((s) => estadoDe(s, installed).outdated).length, [skills, installed]);

  return (
    <div className="spage">
      <PageHead icon={IconBook} title="Skills" sub="Comandos oficiales de Lixbon que enseñan a tu agente a hacer un trabajo completo.">
        <button className="lk" onClick={() => window.open(`${serverUrl || 'https://lixbon.com'}/skills`, '_blank')}>
          <IconExternal size={12} /> lixbon.com/skills
        </button>
      </PageHead>
      <section className="ssec rise rise--1">
        <SectionHead
          label="Catálogo"
          hint={updates ? `${updates} ${updates === 1 ? 'skill tiene' : 'skills tienen'} una versión nueva.` : 'Se instalan en la carpeta de skills de cada agente (Claude Code, Codex, OpenCode…).'}
        >
          <button className="lk" onClick={load}><IconRefresh size={12} /> Actualizar</button>
        </SectionHead>
        {error && <span className="skl-error">{error}</span>}
        {skills === null && <SpinRing size={18} />}
        {skills?.length === 0 && !error && <span className="srow__hint">Aún no hay skills publicadas.</span>}
        <div className="skl-grid">
          {(skills || []).map((s) => {
            const estado = estadoDe(s, installed);
            return (
              <button key={s.slug} type="button" className="skl-card" onClick={() => setOpen(s.slug)}>
                <span className="skl-card__top">
                  <span className="mono skl-cmd">{s.command}</span>
                  <Badge estado={estado} />
                </span>
                <span className="skl-card__title">{s.title}</span>
                <span className="skl-card__summary">{s.summary}</span>
                <span className="skl-card__foot">
                  <Rating skill={s} />
                  <span className="mono skl-muted">v{s.version}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
      {open && (
        <Detail slug={open} agents={agents} installed={installed} onClose={() => setOpen(null)}
          onChanged={async () => {
            const { skills: list } = await api.get('/api/skills');
            setSkills(list);
            await refreshInstalled(list);
          }} />
      )}
    </div>
  );
}
