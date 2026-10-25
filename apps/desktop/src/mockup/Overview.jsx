// Overview.jsx — las cuatro superficies a la vez, vivas, sobre el MISMO estado. Sirve para juzgar si son partes del mismo producto.
import { useStore, attemptById, taskOf, fleetCounts } from './store';
import { Scaled } from './layout';
import { StatePill, Agent, Mark, AttnFlag } from './ui';
import AdeDesktop from './ade/AdeDesktop';
import IdeDesktop from './ide/IdeDesktop';
import MobileApp from './mobile/MobileApp';
import { runCommand } from './cli/CliTerminal';

function CliSnapshot() {
  const s = useStore();
  const out = [runCommand('lxo status', s).out, <div key="a" style={{ marginTop: 10 }}>{runCommand('lxo attention', s).out}</div>];
  return <div className="cli" style={{ height: '100%' }}><div className="cli__title">lxo — PowerShell</div><div className="cli__out"><div className="cl-p"><span className="muted">PS&gt;</span> lxo status</div>{out[0]}<div className="cl-p" style={{ marginTop: 10 }}><span className="muted">PS&gt;</span> lxo attention</div>{out[1]}</div></div>;
}

const LEGEND = [['queued', 'muted', 'Queued'], ['thinking', 'info', 'Thinking'], ['working', 'info', 'Working'], ['tool', 'info', 'Running tool'], ['waiting', 'warn', 'Waiting · cause'], ['review', 'merged', 'Review ready'], ['failed', 'danger', 'Failed'], ['done', 'good', 'Completed'], ['paused', 'muted', 'Paused'], ['offline', 'faint', 'Offline']];

function Legend() {
  return (
    <section className="ovc ov--leg">
      <header><b>One vocabulary</b><span className="muted">shared by all four</span></header>
      <div className="leg">
        <div className="leg__g">{LEGEND.map(([k, t, l]) => <span key={l}><Mark kind={k} tone={t} size={14} />{l}</span>)}</div>
        <div className="leg__r"><AttnFlag n={1} /><span><b>Attention</b> is a separate axis: a person must decide. Activity never raises it.</span></div>
        <div className="leg__r"><i className="unread-dot" /><span><b>Unread</b> ≠ blocked ≠ Attention.</span></div>
        <div className="leg__c">Project → Task → Attempt → Agent · Worktree · Host</div>
        <div className="leg__c">Queue · Steer · Stop &amp; Send · Fork as Attempt</div>
      </div>
    </section>
  );
}

function Card({ title, sub, onOpen, children, className = '' }) {
  return (
    <section className={`ovc ${className}`}>
      <header><b>{title}</b><span className="muted">{sub}</span></header>
      <div className="ovc__stage">{children}</div>
      <button type="button" className="ovc__hit" onClick={onOpen} aria-label={`Open ${title}`} />
    </section>
  );
}

export default function Overview() {
  const s = useStore();
  const set = s.setSurface;
  const a = attemptById(s, s.sel.attemptId);
  const t = taskOf(s, a);
  const c = fleetCounts(s);
  return (
    <div className="ov">
      <div className="ov__same">
        <span className="muted">Same Core, four faces — selected work:</span>
        <b>{t.title}</b><span>Attempt {a.label}</span><Agent attempt={a} size={15} /><StatePill attempt={a} />
        <span className="sp" /><span className="muted">{c.active} working · {c.attention} need you · {c.review} review ready</span>
      </div>
      <div className="ov__grid">
        <Card title="Desktop ADE" sub="Control plane — direct a fleet" onOpen={() => set('ade')} className="ov--ade"><Scaled w={1440} h={880}><AdeDesktop live={false} /></Scaled></Card>
        <Card title="Desktop IDE" sub="Execution plane — edit & run" onOpen={() => set('ide')} className="ov--ide"><Scaled w={1440} h={880}><IdeDesktop live={false} /></Scaled></Card>
        <Card title="Mobile Remote" sub="Attention · decide · control" onOpen={() => set('mobile')} className="ov--mob"><Scaled w={408} h={818}><div style={{ padding: 9 }}><MobileApp live={false} /></div></Scaled></Card>
        <Card title="CLI · lxo" sub="Same words, same ids" onOpen={() => set('cli')} className="ov--cli"><Scaled w={900} h={560}><CliSnapshot /></Scaled></Card>
        <Legend />
      </div>
    </div>
  );
}
