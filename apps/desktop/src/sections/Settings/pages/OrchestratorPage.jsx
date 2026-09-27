// OrchestratorPage.jsx — Ajustes → Orquestador (experimental): activarlo,
// instalar la skill en los agentes del sistema y cómo se lanzan los hijos.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from '../../../store/toastStore';
import { useOrchStore, AGENT_LABELS } from '../../../store/orchStore';
import { Switch } from '../../../components/Switch';
import { Segmented } from '../../../components/Segmented';
import { Select } from '../../../components/Select';

function AgentRow({ a, onInstall, onRemove }) {
  const state = a.installed ? (a.outdated ? 'Desactualizada' : 'Instalada') : a.detected ? 'Sin instalar' : 'No detectado';
  return (
    <div className="srow">
      <div className="srow__text">
        <span className="srow__label">{a.label} <span className={`orch__pill ${a.installed && !a.outdated ? 'is-ok' : a.detected ? 'is-warn' : ''}`}>{state}</span></span>
        <span className="mono srow__tools" title={a.path}>{a.installed ? a.path : a.bin || (a.detected ? 'Carpeta de configuración encontrada' : 'No está en este equipo')}</span>
      </div>
      <div className="ssec__actions">
        {a.installed && <button className="lk" onClick={onRemove}>Quitar</button>}
        {(!a.installed || a.outdated) && <button className="lk is-accent" onClick={onInstall}>{a.outdated ? 'Actualizar' : 'Instalar'}</button>}
      </div>
    </div>
  );
}

export function OrchestratorPage() {
  const { snap, agents, init, loadAgents, saveSettings, installSkill, uninstallSkill } = useOrchStore();
  const settings = snap?.settings;
  const [launchers, setLaunchers] = useState({});
  const [wtRoot, setWtRoot] = useState('');
  const [pathInfo, setPathInfo] = useState(null);

  useEffect(() => { init(); loadAgents(); invoke('orch_path_status').then(setPathInfo).catch(() => {}); }, [init, loadAgents]);

  const addToPath = async () => {
    try {
      setPathInfo(await invoke('orch_add_to_path'));
      toast('lxo añadido a tu PATH. Las terminales que abras a partir de ahora ya lo verán.');
    } catch (e) {
      toast(String(e), { tone: 'error', ms: 8000 });
    }
  };
  useEffect(() => {
    if (settings) { setLaunchers(settings.launchers || {}); setWtRoot(settings.worktree_root || ''); }
  }, [settings]);

  if (!settings) return <div className="spage"><span className="srow__hint">Cargando…</span></div>;

  const detected = agents.filter((a) => a.detected && (!a.installed || a.outdated));
  const agentOptions = Object.keys(settings.launchers || {}).map((id) => ({ value: id, label: AGENT_LABELS[id] || id }));

  return (
    <div className="spage">
      <div className="spage__head rise">
        <div className="spage__title">
          <span className="spage__h1">Orquestador <span className="orch__badge-exp">Experimental</span></span>
          <span className="spage__sub">Varios agentes trabajando a la vez sobre el mismo objetivo, coordinados por uno de ellos.</span>
        </div>
      </div>

      <section className="ssec ssec--card rise rise--1">
        <p className="orch__about">
          Un agente <b>coordinador</b> (el que prefieras: Claude Code, Codex, OpenCode, Lixbon…) divide el objetivo en tareas y lanza
          agentes <b>hijos</b>. Cada hijo trabaja en su propia terminal, en una rama y un worktree de git propios, y puede tener a su
          vez sus propios hijos. Todos hablan con Lixbon mediante la CLI <span className="mono">lxo</span>: informan de sus fases,
          preguntan a su padre y avisan al terminar. Tú lo sigues en el modo <b>Orquestar</b> y decides qué se fusiona o sube como PR.
        </p>
        <div className="srow">
          <div className="srow__text">
            <span className="srow__label">Activar el orquestador</span>
            <span className={`srow__hint ${settings.enabled && !snap.lxo_exists ? 'is-warn' : ''}`}>
              {settings.enabled
                ? (snap.lxo_exists ? `Escuchando en 127.0.0.1:${snap.server} · lxo en ${snap.lxo}` : 'Activo, pero falta lxo junto al ejecutable de Lixbon: reinstala la app.')
                : 'Mientras esté apagado, lxo responde que el orquestador está desactivado.'}
            </span>
          </div>
          <Switch checked={!!settings.enabled} onChange={(v) => saveSettings({ enabled: v })} label="Activar el orquestador" />
        </div>
      </section>

      <section className="ssec rise rise--2">
        <div className="ssec__row">
          <span className="ssec__label">Skill en tus agentes</span>
          <div className="panelhead__fill" />
          {detected.length > 0 && (
            <button className="lk is-accent" onClick={() => installSkill(detected.map((a) => a.id))}>Instalar en todos los detectados ({detected.length})</button>
          )}
        </div>
        <div className="ssec ssec--card ssec--rows">
          <span className="srow__hint orch__intro">
            Una sola skill, <span className="mono">lixbon-orquestador</span>, sirve para ser coordinador y para ser hijo. Instálala en los
            agentes que quieras usar; después basta con pedirles «orquesta esto con lxo». Desde el chat de Lixbon: <span className="mono">/orquestar &lt;objetivo&gt;</span>.
          </span>
          {agents.map((a) => (
            <AgentRow key={a.id} a={a} onInstall={() => installSkill([a.id])} onRemove={() => uninstallSkill([a.id])} />
          ))}
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Lixbon (este IDE) <span className={`orch__pill ${settings.enabled ? 'is-ok' : ''}`}>{settings.enabled ? 'Integrado' : 'Apagado'}</span></span>
              <span className="srow__hint">El agente de Lixbon recibe la guía del orquestador directamente mientras esté activado.</span>
            </div>
          </div>
        </div>
      </section>

      <section className="ssec ssec--card rise rise--2">
        <div className="srow">
          <div className="srow__text">
            <span className="srow__label">Usar <span className="mono">lxo</span> desde cualquier terminal</span>
            <span className="srow__hint">
              {pathInfo?.in_path
                ? `Ya está en tu PATH (${pathInfo.dir}).`
                : 'Los agentes que lanza Lixbon y los que usan la skill no lo necesitan. Añádelo al PATH si quieres escribir lxo tú mismo en una terminal.'}
            </span>
          </div>
          {pathInfo && !pathInfo.in_path && pathInfo.supported && <button className="lk is-accent" onClick={addToPath}>Añadir al PATH</button>}
        </div>
      </section>

      <section className="ssec ssec--card rise rise--3">
        <div className="srow">
          <div className="srow__text">
            <span className="srow__label">Agente por defecto para los hijos</span>
            <span className="srow__hint">El coordinador puede elegir otro en cada tarea (lxo spawn --agent).</span>
          </div>
          <Select value={settings.default_agent} onChange={(v) => saveSettings({ default_agent: v })} options={agentOptions} />
        </div>
        <div className="srow">
          <div className="srow__text">
            <span className="srow__label">Niveles de hijos</span>
            <span className="srow__hint">1: solo hijos · 2: hijos y nietos. Más niveles multiplican agentes y consumo.</span>
          </div>
          <Segmented size="sm" width={44} value={String(settings.max_depth)} onChange={(v) => saveSettings({ max_depth: Number(v) })}
            options={['1', '2', '3', '4'].map((v) => ({ value: v, label: v }))} />
        </div>
        <div className="srow">
          <div className="srow__text">
            <span className="srow__label">Carpeta de los worktrees</span>
            <span className="srow__hint">Vacía: junto al repositorio, en <span className="mono">&lt;repo&gt;.lixbon-wt/</span>.</span>
          </div>
          <div className="field field--strong orch__field">
            <input value={wtRoot} placeholder="Predeterminada" onChange={(e) => setWtRoot(e.target.value)} onBlur={() => wtRoot !== settings.worktree_root && saveSettings({ worktree_root: wtRoot.trim() })} />
          </div>
        </div>
      </section>

      <section className="ssec rise rise--3">
        <span className="ssec__label">Notificaciones</span>
        <div className="ssec ssec--card ssec--rows">
          {[
            ['notify_phases', 'Fase terminada', 'Cada vez que un agente cierra una fase de su tarea.'],
            ['notify_done', 'Tarea terminada o cerrada', 'Cuando un agente acaba (bien o mal) o su terminal se cierra.'],
            ['notify_questions', 'Preguntas', 'Cuando un agente se queda esperando una decisión.'],
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

      <section className="ssec rise rise--3">
        <span className="ssec__label">Cómo se lanza cada agente</span>
        <div className="ssec ssec--card ssec--rows">
          <span className="srow__hint orch__intro">
            <span className="mono">{'{prompt}'}</span> se sustituye por la instrucción inicial. Si el comando no lo lleva, Lixbon la escribe en
            la terminal cuando el agente está listo. Añade aquí los flags que quieras (modelo, permisos…).
          </span>
          {Object.keys(launchers).map((id) => (
            <div key={id} className="srow">
              <span className="srow__label orch__launcher-name">{AGENT_LABELS[id] || id}</span>
              <div className="field field--strong orch__field orch__field--wide">
                <input
                  className="mono"
                  value={launchers[id]}
                  onChange={(e) => setLaunchers((l) => ({ ...l, [id]: e.target.value }))}
                  onBlur={() => launchers[id] !== settings.launchers[id] && saveSettings({ launchers })}
                />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
