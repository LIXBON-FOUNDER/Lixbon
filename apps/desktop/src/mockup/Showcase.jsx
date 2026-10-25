// Showcase.jsx — ruta global: Desktop ADE · Desktop IDE · Mobile · CLI, más Overview, Continuidad y Guía. Todo con datos ficticios.
// Deep link para revisar rápido: mockup.html#ade/attention · #ade/proof/att_oa_b · #ide · #mobile · #cli · #flow · #guide
import { useEffect } from 'react';
import { useStore } from './store';
import { Scaled } from './layout';
import SimPanel from './SimPanel';
import Overview from './Overview';
import AdeDesktop from './ade/AdeDesktop';
import OrchDesktop from './orch/OrchDesktop';
import IdeDesktop from './ide/IdeDesktop';
import MobileApp from './mobile/MobileApp';
import CliTerminal, { CliHints } from './cli/CliTerminal';
import Continuity from './Continuity';
import Guide from './Guide';
import DeskShell from './desk/DeskShell';

const TABS = [
  ['all', 'Overview'],
  ['desk', 'Desktop integrado'],
  ['orch', 'Orquestador'],
  ['ade', 'Desktop ADE (Original)'],
  ['ide', 'Desktop IDE'],
  ['mobile', 'Mobile'],
  ['cli', 'CLI'],
  ['flow', 'Continuity'],
  ['guide', 'Guide'],
];
const VIEWS = ['workspace', 'attention', 'compare', 'proof', 'review', 'hosts', 'usage', 'map'];
// Se captura UNA vez al cargar el módulo (StrictMode ejecuta los efectos dos veces y el segundo ya vería el hash reescrito).
const INITIAL_HASH = typeof window !== 'undefined' ? window.location.hash.slice(1) : '';

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return <div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast toast--${t.tone}`}>{t.text}</div>)}</div>;
}

function MobilePage() {
  return (
    <div className="page2">
      <div className="page2__main"><Scaled w={408} h={818}><div style={{ padding: 9 }}><MobileApp /></div></Scaled></div>
      <aside className="page2__side">
        <h3>Mobile Remote — not a mini-IDE</h3>
        <p>A decision surface for work that <b>keeps running on its host</b>. Try: open <b>Attention</b>, approve the Chromium network request (high risk asks you to read the command), open a Task and <b>Queue</b> an instruction, or Review → <b>Open full review on Desktop</b>.</p>
        <h3>You can</h3>
        <ul><li>See Attention, agents working, Review ready, errors, hosts</li><li>Approve / deny with visible command, risk and scope</li><li>Answer blocking questions</li><li>Send Queue / Steer / Stop &amp; Send; Pause / Stop</li><li>Read the Proof Pack and accept <i>that</i> revision</li></ul>
        <h3>You can’t (by design)</h3>
        <ul><li>Edit code or read a full diff</li><li>Move execution off the host</li><li>“Allow always” on high-impact actions</li></ul>
        <p className="muted">Use the <b>Simulate</b> menu → “Agent asks for a permission” to trigger a push banner here.</p>
      </aside>
    </div>
  );
}

function CliPage() {
  const run = (c) => useStore.setState((st) => ({ cli: { ...st.cli, run: c } }));
  return (
    <div className="page2 page2--cli">
      <div className="page2__term"><CliTerminal /></div>
      <CliHints onRun={run} />
    </div>
  );
}

export default function Showcase() {
  const s = useStore();
  useEffect(() => { document.documentElement.dataset.theme = s.theme; }, [s.theme]);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('theme') === 'light') useStore.getState().setTheme('light');
    const [surf, view, id] = INITIAL_HASH.split('/');
    if (surf === 'mobile' && view) { // #mobile/attention · #mobile/task/att_rt_a · #mobile/approval/at_net_ch · #mobile/review/att_oa_b
      const m = useStore.getState();
      if (['home', 'tasks', 'attention', 'hosts'].includes(view)) m.mTab(view);
      else if (id) m.mOpen(view, view === 'approval' ? { id } : { attemptId: id });
    } else if (id) useStore.getState().select(id, VIEWS.includes(view) ? view : 'workspace');
    else if (view && VIEWS.includes(view)) useStore.getState().setView(view);
    if (TABS.some(([t]) => t === surf)) useStore.getState().setSurface(surf);
  }, []);
  useEffect(() => { try { window.history.replaceState(null, '', `#${s.surface}`); } catch { /* sandbox */ } }, [s.surface]);
  const surface = s.surface;
  return (
    <div className="show mkr">
      <header className="show__bar">
        <b className="show__brand">LIXBON</b><span className="muted show__tag">unified mockup · mock data · no Core attached</span>
        <nav className="show__tabs" role="tablist" aria-label="Surfaces">
          {TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={surface === id} className={surface === id ? 'is-on' : ''} onClick={() => s.setSurface(id)}>{label}</button>)}
        </nav>
        <span className="sp" />
        <SimPanel />
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.setTheme(s.theme === 'dark' ? 'light' : 'dark')}>{s.theme === 'dark' ? 'Light' : 'Dark'}</button>
      </header>
      <div className="show__stage">
        {surface === 'all' && <Overview />}
        {surface === 'desk' && <DeskShell />}
        {surface === 'orch' && <OrchDesktop />}
        {surface === 'ade' && <AdeDesktop />}
        {surface === 'ide' && <IdeDesktop />}
        {surface === 'mobile' && <MobilePage />}
        {surface === 'cli' && <CliPage />}
        {surface === 'flow' && <Continuity />}
        {surface === 'guide' && <Guide />}
      </div>
      <Toasts />
    </div>
  );
}
