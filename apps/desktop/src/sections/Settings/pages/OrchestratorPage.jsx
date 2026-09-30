// OrchestratorPage.jsx — Ajustes → Orquestador (experimental). Aquí se activa,
// se asigna modelo y esfuerzo a cada rol del equipo (el coordinador lanza hijas
// por rol y no puede cambiarlos) y se elige qué se notifica.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useOrchStore } from '../../../store/orchStore';
import { Switch } from '../../../components/Switch';
import { Select } from '../../../components/Select';
import { IconNodes } from '../../../components/Icons';
import { PageHead, SectionHead } from '../SettingsParts';

const EFFORT_LABELS = { low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máximo' };

/** Modelo y esfuerzo de cada rol. Todos corren en Claude Code por ahora. */
function Roles({ roles, settings, claude, onSave }) {
  const models = claude?.models?.length ? claude.models.map((m) => m.id) : ['haiku', 'sonnet', 'opus'];
  const efforts = claude?.efforts?.length ? claude.efforts : Object.keys(EFFORT_LABELS);
  const save = (id, patch) => {
    const current = settings.roles?.[id] || { model: roles.find((r) => r.id === id)?.model || '', effort: roles.find((r) => r.id === id)?.effort || '' };
    onSave({ roles: { ...settings.roles, [id]: { ...current, ...patch } } });
  };
  return (
    <section className="ssec rise rise--2">
      <SectionHead
        label="Roles del equipo"
        hint="El coordinador planifica con el modelo de su chat y lanza a cada hija por rol, con el modelo que elijas aquí (no puede cambiarlo). Pon lo barato en lo que solo lee y reserva el caro para cuando haga falta."
      />
      <div className="ssec ssec--card ssec--rows">
        {roles.map((r) => {
          const opts = [...new Set([...models, r.model])].map((id) => ({ value: id, label: id }));
          return (
            <div key={r.id} className="srow">
              <div className="srow__text">
                <span className="srow__label">
                  {r.label} {r.read_only && <span className="orch__pill is-ok">Solo lectura</span>}
                </span>
                <span className="srow__hint">{r.purpose}</span>
              </div>
              <div className="orch__rolectl">
                <Select className="select--fill" value={r.model} onChange={(model) => save(r.id, { model })} options={opts} title={`Modelo del ${r.label.toLowerCase()}`} />
                <Select
                  className="select--fill"
                  value={r.effort || ''}
                  onChange={(effort) => save(r.id, { effort })}
                  options={[{ value: '', label: 'Esfuerzo por defecto' }, ...efforts.map((e) => ({ value: e, label: `Esfuerzo ${(EFFORT_LABELS[e] || e).toLowerCase()}` }))]}
                  title={`Esfuerzo del ${r.label.toLowerCase()}`}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SkillRow({ a, onInstall, onRemove }) {
  const state = a.installed ? (a.outdated ? 'Desactualizada' : 'Instalada') : 'Sin instalar';
  return (
    <div className="srow">
      <div className="srow__text">
        <span className="srow__label">{a.label} <span className={`orch__pill ${a.installed && !a.outdated ? 'is-ok' : 'is-warn'}`}>{state}</span></span>
        <span className="mono srow__tools" title={a.path}>{a.installed ? a.path : a.bin || 'Carpeta de configuración encontrada'}</span>
      </div>
      <div className="ssec__actions">
        {a.installed && !a.outdated && <button className="lk" onClick={onRemove}>Quitar</button>}
        {(!a.installed || a.outdated) && <button className="lk is-accent" onClick={onInstall}>{a.outdated ? 'Actualizar' : 'Instalar'}</button>}
      </div>
    </div>
  );
}

/** Agentes instalados y sus modelos (la consulta a cada CLI tarda; Rust la cachea). */
function useTeam(enabled) {
  const [agents, setAgents] = useState(null);
  const [loading, setLoading] = useState(false);
  const load = async (refresh = false) => {
    setLoading(true);
    try {
      const res = await invoke('orch_call', { cmd: 'agents', args: { refresh } });
      setAgents(res.agents || []);
    } catch { setAgents([]); }
    setLoading(false);
  };
  useEffect(() => { if (enabled) load(); }, [enabled]);
  return { agents, loading, load };
}

function Team({ enabled, team }) {
  const { agents, loading, load } = team;

  return (
    <section className="ssec rise rise--2">
      <SectionHead
        label="Agentes instalados"
        hint="Los CLI que Lixbon sabe lanzar y los modelos que ofrecen. Fuera de los roles, el coordinador solo los usa si se lo pides."
      >
        {enabled && <button className="lk" disabled={loading} onClick={() => load(true)}>{loading ? 'Consultando…' : 'Volver a consultar'}</button>}
      </SectionHead>
      <div className="ssec ssec--card ssec--rows">
        {!enabled && <span className="srow__hint">Activa el orquestador para consultarlos.</span>}
        {enabled && agents === null && <span className="srow__hint">Consultando a cada agente…</span>}
        {enabled && agents?.length === 0 && <span className="srow__hint">No se encontró ningún agente compatible (claude, codex, gemini).</span>}
        {enabled && <span className="srow__hint">Cursor y OpenCode pueden coordinar con /orquestar, pero todavía no trabajan como agentes hijos en Windows.</span>}
        {agents?.map((a) => (
          <div key={a.id} className="srow">
            <div className="srow__text">
              <span className="srow__label">{a.label}</span>
              <span className="srow__hint">{a.strengths}</span>
              <span className="mono srow__tools" title={a.models.map((m) => m.id).join(', ')}>
                {a.models.length ? `${a.models.length} modelo${a.models.length === 1 ? '' : 's'}: ${a.models.slice(0, 6).map((m) => m.id).join(', ')}${a.models.length > 6 ? '…' : ''}` : 'No lista modelos: el coordinador pasa el id directamente'}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function OrchestratorPage() {
  const { snap, agents, init, loadAgents, saveSettings, installSkill, uninstallSkill } = useOrchStore();
  const settings = snap?.settings;
  const team = useTeam(!!settings?.enabled);

  useEffect(() => { init(); loadAgents(); }, [init, loadAgents]);
  useEffect(() => { if (settings?.enabled) loadAgents(); }, [settings?.enabled, loadAgents]);

  if (!settings) return <div className="spage"><span className="srow__hint">Cargando…</span></div>;

  const detected = agents.filter((a) => a.detected);
  const pending = detected.filter((a) => !a.installed || a.outdated);

  return (
    <div className="spage">
      <PageHead icon={IconNodes} title={<>Orquestador <span className="orch__badge-exp">Experimental</span></>} sub="Un chat coordina a un equipo de agentes que trabajan a la vez sobre el mismo objetivo." />

      <section className="ssec rise rise--1">
        <SectionHead label="Cómo funciona" />
        <div className="ssec ssec--card">
          <p className="orch__about">
            Escribe <span className="mono">/orquestar &lt;objetivo&gt;</span> en el chat de Lixbon o en Claude Code. Ese chat pasa a ser
            el <b>coordinador</b>: divide el objetivo en tareas, las reparte por <b>rol</b> (explorar, implementar, revisar), cada una en
            su rama y su worktree, espera el <b>informe</b> de cada agente, integra los cambios y te cuenta qué se hizo. Tú solo hablas
            con él; en el modo <b>Orquestar</b> puedes mirar qué hace cada agente.
          </p>
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Activar el orquestador</span>
              <span className={`srow__hint ${settings.enabled && !snap.lxo_exists ? 'is-warn' : ''}`}>
                {settings.enabled
                  ? (snap.lxo_exists ? 'Activo. Al activarlo se instaló la skill /orquestar en tus agentes.' : 'Activo, pero falta lxo junto al ejecutable de Lixbon: reinstala la app.')
                  : 'Al activarlo se instala la skill /orquestar en todos los agentes que tengas.'}
              </span>
            </div>
            <Switch checked={!!settings.enabled} onChange={async (v) => { await saveSettings({ enabled: v }); loadAgents(); }} label="Activar el orquestador" />
          </div>
        </div>
      </section>

      <Roles roles={snap.roles || []} settings={settings} claude={team.agents?.find((a) => a.id === 'claude')} onSave={saveSettings} />

      <Team enabled={!!settings.enabled} team={team} />

      <section className="ssec rise rise--3">
        <SectionHead
          label="Skill /orquestar"
          hint="La misma skill sirve para coordinar (cuando tú la invocas) y para trabajar como agente hijo (cuando Lixbon lanza al agente)."
        >
          {pending.length > 0 && <button className="lk is-accent" onClick={() => installSkill(pending.map((a) => a.id))}>Instalar en todos ({pending.length})</button>}
        </SectionHead>
        <div className="ssec ssec--card ssec--rows">
          {detected.length === 0 && <span className="srow__hint">No se encontró ningún agente en este equipo.</span>}
          {detected.map((a) => (
            <SkillRow key={a.id} a={a} onInstall={() => installSkill([a.id])} onRemove={() => uninstallSkill([a.id])} />
          ))}
        </div>
      </section>

      <section className="ssec rise rise--3">
        <SectionHead label="Notificaciones" hint="Avisos del sistema mientras el equipo trabaja." />
        <div className="ssec ssec--card ssec--rows">
          {[
            ['notify_phases', 'Fase terminada', 'Cada vez que un agente cierra una fase de su tarea.'],
            ['notify_done', 'Tarea entregada o cerrada', 'Cuando un agente entrega su informe o su terminal se cierra.'],
            ['notify_questions', 'Preguntas al coordinador', 'Cuando un agente se queda esperando una decisión.'],
          ].map(([key, label, hint]) => (
            <div key={key} className="srow">
              <div className="srow__text">
                <span className="srow__label">{label}</span>
                <span className="srow__hint">{hint}</span>
              </div>
              <Switch checked={!!settings[key]} onChange={(v) => saveSettings({ [key]: v })} label={label} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
