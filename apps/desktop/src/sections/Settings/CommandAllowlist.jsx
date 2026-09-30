// CommandAllowlist.jsx — comandos que el agente ejecuta sin preguntar: fichas
// agrupadas por herramienta (npm, cargo, git…), alta con Enter, restaurar los
// predeterminados y un probador que explica qué pasará con un comando concreto.
import { useMemo, useState } from 'react';
import { DEFAULT_CMD_ALLOWLIST, commandVerdict } from '../../lib/agentProtocol';
import { IconTerminal, IconX, IconPlus, IconCheck, IconWarn } from '../../components/Icons';
import { SectionHead } from './SettingsParts';

const VERDICT_TEXT = {
  listed: (m) => `Se ejecuta sin preguntar: coincide con «${m}».`,
  unlisted: () => 'Preguntará: no empieza por ninguno de la lista.',
  chain: () => 'Preguntará siempre: encadena, redirige o abre un subshell (&&, |, ;, >, $(…)).',
  never: () => 'Preguntará siempre: ejecuta código externo, instala paquetes o borra (npx, curl, rm, npm install, -e/-c…).',
};

/** Agrupa por la primera palabra; las herramientas con una sola entrada de una
    palabra (ls, pwd, make…) van juntas al final. */
function groupByTool(list) {
  const groups = new Map();
  for (const cmd of list) {
    const [tool, ...rest] = cmd.split(/\s+/);
    const key = tool.toLowerCase();
    if (!groups.has(key)) groups.set(key, { tool, items: [] });
    groups.get(key).items.push({ cmd, rest: rest.join(' ') });
  }
  const multi = [];
  const loose = [];
  for (const g of groups.values()) {
    if (g.items.length === 1 && !g.items[0].rest) loose.push(g.items[0]);
    else multi.push(g);
  }
  return { multi, loose };
}

export function CommandAllowlist({ list, onChange, commandPolicy }) {
  const [draft, setDraft] = useState('');
  const [probe, setProbe] = useState('');
  const { multi, loose } = useMemo(() => groupByTool(list), [list]);

  const clean = draft.trim().replace(/\s+/g, ' ');
  const exists = list.some((c) => c.toLowerCase() === clean.toLowerCase());
  const draftVerdict = clean ? commandVerdict(clean, [clean]) : null;
  const draftProblem = !clean ? '' : exists ? 'Ya está en la lista.'
    : draftVerdict.reason === 'chain' || draftVerdict.reason === 'never' ? 'Ese comando pide permiso siempre, aunque esté en la lista.' : '';

  const add = () => {
    if (!clean || exists) return;
    onChange([...list, clean]);
    setDraft('');
  };
  const remove = (cmd) => onChange(list.filter((c) => c !== cmd));
  const isDefault = list.length === DEFAULT_CMD_ALLOWLIST.length && DEFAULT_CMD_ALLOWLIST.every((c) => list.includes(c));
  const verdict = probe.trim() ? commandVerdict(probe, list) : null;

  return (
    <section className="ssec rise rise--3">
      <SectionHead
        label={`Comandos permitidos sin preguntar · ${list.length}`}
        hint="Cuentan el comando exacto o cualquiera que empiece por él: «cargo test» permite también «cargo test --release»."
      >
        {!isDefault && <button className="lk" onClick={() => onChange(DEFAULT_CMD_ALLOWLIST)}>Restaurar predeterminados</button>}
      </SectionHead>

      <div className="ssec ssec--card allow">
        {commandPolicy !== 'ask' && (
          <span className="allow__notice">
            <IconWarn size={13} />
            {commandPolicy === 'allow'
              ? 'Ahora «Ejecutar comandos» está en Permitir: el agente ya ejecuta sin preguntar y esta lista no se usa.'
              : 'Ahora «Ejecutar comandos» está en Nunca: el agente no ejecuta comandos y esta lista no se usa.'}
          </span>
        )}

        <div className="allow__add">
          <div className="field field--strong allow__input">
            <IconTerminal size={13} />
            <input
              className="mono"
              value={draft}
              placeholder="Añadir un comando, por ejemplo npm run lint"
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
            />
          </div>
          <button className="btn btn--ghost" onClick={add} disabled={!clean || exists}><IconPlus size={13} /> Añadir</button>
        </div>
        {draftProblem && <span className="srow__hint is-warn">{draftProblem}</span>}

        {list.length === 0 && <span className="srow__hint">La lista está vacía: el agente preguntará antes de cada comando.</span>}

        <div className="allow__groups">
          {multi.map((g) => (
            <div key={g.tool} className="allow__group">
              <span className="mono allow__tool">{g.tool}</span>
              <div className="allow__chips">
                {g.items.map((it) => (
                  <span key={it.cmd} className="allow__chip mono" title={it.cmd}>
                    {it.rest || <span className="allow__any">(solo)</span>}
                    <button className="allow__x" onClick={() => remove(it.cmd)} aria-label={`Quitar ${it.cmd}`}><IconX size={10} /></button>
                  </span>
                ))}
              </div>
            </div>
          ))}
          {loose.length > 0 && (
            <div className="allow__group">
              <span className="allow__tool allow__tool--loose">Otros</span>
              <div className="allow__chips">
                {loose.map((it) => (
                  <span key={it.cmd} className="allow__chip mono">
                    {it.cmd}
                    <button className="allow__x" onClick={() => remove(it.cmd)} aria-label={`Quitar ${it.cmd}`}><IconX size={10} /></button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="allow__probe">
          <span className="fieldlabel">Probar un comando</span>
          <div className="field field--strong allow__input">
            <IconTerminal size={13} />
            <input className="mono" value={probe} placeholder="cargo test --release" spellCheck={false} onChange={(e) => setProbe(e.target.value)} />
          </div>
          {verdict && (
            <span className={`allow__verdict ${verdict.allowed ? 'is-ok' : 'is-ask'}`}>
              {verdict.allowed ? <IconCheck size={13} /> : <IconWarn size={13} />}
              {VERDICT_TEXT[verdict.reason](verdict.match)}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
