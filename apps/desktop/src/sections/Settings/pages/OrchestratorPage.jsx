// OrchestratorPage.jsx — Ajustes → Orquestador (experimental). No hay nada que
// configurar del equipo: el coordinador elige agente y modelo por tarea. Aquí
// solo se activa, se ve qué agentes tiene a su alcance y qué se notifica.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useOrchStore } from '../../../store/orchStore';
import { Switch } from '../../../components/Switch';

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

function Team({ enabled }) {
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

  return (
    <section className="ssec rise rise--2">
      <div className="ssec__row">
        <span className="ssec__label">Agentes que puede usar el coordinador</span>
        <div className="panelhead__fill" />
        {enabled && <button className="lk" disabled={loading} onClick={() => load(true)}>{loading ? 'Consultando…' : 'Volver a consultar'}</button>}
      </div>
      <div className="ssec ssec--card ssec--rows">
        <span className="srow__hint orch__intro">
          Lixbon pregunta a cada CLI instalada qué modelos ofrece. El coordinador elige de aquí el agente y el modelo de cada
          tarea (por ejemplo Opus para programar y Haiku para leer o documentar) y los lanza en
          autónomo, sin pedir permisos, cada uno en su propio worktree.
        </span>
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

  useEffect(() => { init(); loadAgents(); }, [init, loadAgents]);
  useEffect(() => { if (settings?.enabled) loadAgents(); }, [settings?.enabled, loadAgents]);

  if (!settings) return <div className="spage"><span className="srow__hint">Cargando…</span></div>;

  const detected = agents.filter((a) => a.detected);
  const pending = detected.filter((a) => !a.installed || a.outdated);

  return (
    <div className="spage">
      <div className="spage__head rise">
        <div className="spage__title">
          <span className="spage__h1">Orquestador <span className="orch__badge-exp">Experimental</span></span>
          <span className="spage__sub">Un chat coordina a un equipo de agentes que trabajan a la vez sobre el mismo objetivo.</span>
        </div>
      </div>

      <section className="ssec ssec--card rise rise--1">
        <p className="orch__about">
          Escribe <span className="mono">/orquestar &lt;objetivo&gt;</span> en el chat de Lixbon o en cualquier agente con la skill
          (Claude Code, Cursor, OpenCode, Codex). Ese chat pasa a ser el <b>coordinador</b>: divide el objetivo en tareas, elige
          para cada una el agente y el modelo, las lanza en autónomo (cada una en su rama y su worktree), espera el
          <b> informe</b> de cada agente, integra los cambios y te cuenta qué se hizo y en qué archivos. Tú solo hablas con él; en el
          modo <b>Orquestar</b> puedes mirar qué hace cada agente.
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
      </section>

      <Team enabled={!!settings.enabled} />

      <section className="ssec rise rise--3">
        <div className="ssec__row">
          <span className="ssec__label">Skill /orquestar</span>
          <div className="panelhead__fill" />
          {pending.length > 0 && <button className="lk is-accent" onClick={() => installSkill(pending.map((a) => a.id))}>Instalar en todos ({pending.length})</button>}
        </div>
        <div className="ssec ssec--card ssec--rows">
          <span className="srow__hint orch__intro">
            La misma skill sirve para coordinar (cuando tú la invocas) y para trabajar como agente hijo (cuando Lixbon lanza al agente).
          </span>
          {detected.length === 0 && <span className="srow__hint">No se encontró ningún agente en este equipo.</span>}
          {detected.map((a) => (
            <SkillRow key={a.id} a={a} onInstall={() => installSkill([a.id])} onRemove={() => uninstallSkill([a.id])} />
          ))}
        </div>
      </section>

      <section className="ssec rise rise--3">
        <span className="ssec__label">Notificaciones</span>
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
