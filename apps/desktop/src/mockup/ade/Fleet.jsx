// Fleet.jsx — Hosts y Usage. La computación y el consumo son parte del contexto de cada decisión, no un dashboard empresarial.
import { useStore, hostCount } from '../store';
import { PROVIDERS, USAGE } from '../data';
import { Mark, I, Meter, money, ProvMark, Agent } from '../ui';
import { agentShort, stateLabel, hostOf } from '../vocab';

export function HostsView() {
  const s = useStore();
  return (
    <div className="pad">
      <header className="v-head"><h1 className="v-title">Hosts</h1><span className="muted">Where each Attempt really runs. The host stays the owner of execution — clients (ADE, phone, CLI) only observe and decide.</span></header>
      <div className="hosts">
        {s.hosts.map((h) => {
          const atts = s.attempts.filter((a) => a.host === h.id);
          return (
            <article key={h.id} className={`host ${h.status === 'offline' ? 'is-off' : ''}`}>
              <header>
                <span className={`host__dot ${h.status}`} />
                <b>{h.name}</b>
                <span className="chip chip--tag chip--dim">{h.transport}</span>
                <span className="sp" />
                <span className={h.status === 'online' ? 'good' : 'muted'}>{h.status === 'online' ? 'Online' : 'Offline'}</span>
              </header>
              <div className="muted">{h.os} · {h.note}</div>
              <div className="host__n"><b>{hostCount(s, h.id)}</b> agent{hostCount(s, h.id) === 1 ? '' : 's'} · {atts.filter((a) => a.state === 'working').length} working</div>
              <ul className="host__list">
                {atts.slice(0, 5).map((a) => (
                  <li key={a.id}><button type="button" onClick={() => s.select(a.id)}><Mark attempt={a} size={12} /><span className="trunc grow">{s.tasks.find((t) => t.id === a.taskId).title}</span><span className="muted">{agentShort(a)}</span></button></li>
                ))}
                {atts.length > 5 && <li className="muted">+{atts.length - 5} more</li>}
                {!atts.length && <li className="muted">No Attempts</li>}
              </ul>
              <footer>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.toggleHost(h.id)}><span className="dbadge">sim</span>{h.status === 'online' ? 'Disconnect' : 'Reconnect'}</button>
                {h.id !== 'desktop' && <button type="button" className="btn btn--text btn--sm" onClick={() => s.toast('Pairing / SSH settings (simulated)')}>Settings</button>}
              </footer>
            </article>
          );
        })}
      </div>

      <h2 className="v-sub">Resources <span className="muted">· worktrees cost disk; nothing unmerged is ever deleted without a clear confirmation</span></h2>
      <table className="tbl tbl--wide">
        <thead><tr><th>Worktree</th><th>Host</th><th>Size</th><th>Last active</th><th>Git</th><th /></tr></thead>
        <tbody>
          {[['OAuth old experiment', 'Desktop-PC', '4.2 GB', '18 d', 'clean'], ['Codex retry 04', 'Desktop-PC', '2.8 GB', '9 d', 'unmerged'], ['Old docs', 'MacBook', '1.1 GB', '31 d', 'merged'], ['External · feature/foo', 'Desktop-PC', '8.4 GB', '2 d', 'dirty']].map(([n, h, sz, la, g]) => (
            <tr key={n}><td>{n}</td><td>{h}</td><td className="mono">{sz}</td><td className="muted">{la}</td><td><span className={`chip chip--${g === 'merged' || g === 'clean' ? 'good' : 'warn'}`}>{g}</span></td>
              <td><button type="button" className="btn btn--ghost btn--sm" onClick={() => s.toast(g === 'merged' || g === 'clean' ? `${n} archived (simulated)` : `${n}: blocked — has unintegrated work. Open it first.`, g === 'merged' || g === 'clean' ? 'good' : 'warn')}>Archive</button></td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UsageView() {
  const s = useStore();
  return (
    <div className="pad">
      <header className="v-head"><h1 className="v-title">Usage</h1><span className="muted">To decide which agent to keep using — not to audit finance.</span></header>
      {USAGE.filter((u) => u.pct >= 70).map((u) => (
        <div key={u.provider} className="callout callout--warn">
          <b>{PROVIDERS[u.provider].name} {u.windowLabel}: {u.pct}% used</b> · resets in {u.reset}. New Attempts will ask before using it; Codex has headroom ({USAGE[1].pct}%). Lixbon never switches provider silently.
        </div>
      ))}
      <div className="usage">
        {USAGE.map((u) => {
          const atts = s.attempts.filter((a) => a.provider === u.provider);
          const done = atts.filter((a) => ['review_ready', 'completed'].includes(a.state));
          const cost = atts.reduce((n, a) => n + a.cost, 0);
          return (
            <article key={u.provider} className="usec">
              <header><ProvMark id={u.provider} size={20} /><b>{PROVIDERS[u.provider].name}</b><span className="sp" /><span className="muted">{u.windowLabel}</span></header>
              <div className="usec__big"><div><small>Today</small><b>{money(u.today)}</b></div><div><small>Tokens</small><b>{u.tokens}</b></div><div><small>Attempts</small><b>{atts.length}</b></div></div>
              <div className="usec__m"><Meter pct={u.pct} /><span>{u.pct}% · resets {u.reset}</span></div>
              <p className="usec__hint">{u.hint}</p>
              <div className="usec__d muted">{done.length ? `${money(cost / Math.max(1, done.length))} per Attempt that reached review` : 'No finished Attempts yet'}</div>
              <ul className="usec__l">{atts.sort((a, b) => b.cost - a.cost).slice(0, 3).map((a) => <li key={a.id}><button type="button" onClick={() => s.select(a.id)}><span className="trunc grow">{s.tasks.find((t) => t.id === a.taskId).title} · {a.label}</span><span className="mono">{money(a.cost)}</span></button></li>)}</ul>
            </article>
          );
        })}
      </div>

      <section className="usx" aria-label="Spend per Attempt">
        <h2 className="v-sub">Per Attempt <span className="muted">· {s.attempts.length} Attempts, most expensive first</span></h2>
        <table className="tbl tbl--wide">
          <thead><tr><th>Task · Attempt</th><th>Agent</th><th>State</th><th>Host</th><th className="num">Tokens</th><th className="num">Cost</th></tr></thead>
          <tbody>
            {[...s.attempts].sort((a, b) => b.cost - a.cost).map((a) => (
              <tr key={a.id}>
                <td><button type="button" className="usx__open" onClick={() => s.select(a.id)}><span className="trunc">{s.tasks.find((t) => t.id === a.taskId).title} · {a.label}</span></button></td>
                <td><Agent attempt={a} size={14} /></td>
                <td><span className="usx__st"><Mark attempt={a} size={12} />{stateLabel(a)}</span></td>
                <td className="muted">{hostOf(a.host).name}</td>
                <td className="mono num">{(a.tokens / 1000).toFixed(0)}k</td>
                <td className="mono num">{money(a.cost)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan="4">Total · estimated, simulated</td><td className="mono num">{(s.attempts.reduce((n, a) => n + a.tokens, 0) / 1000).toFixed(0)}k</td><td className="mono num">{money(s.attempts.reduce((n, a) => n + a.cost, 0))}</td></tr></tfoot>
        </table>
      </section>
    </div>
  );
}
