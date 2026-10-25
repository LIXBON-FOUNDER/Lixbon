// Continuity.jsx — "una Task que sobrevive al cambio de dispositivo". Cada paso aplica cambios REALES al estado simulado compartido.
import { useState } from 'react';
import { useStore } from './store';
import { Scaled } from './layout';
import { I } from './ui';
import AdeDesktop from './ade/AdeDesktop';
import IdeDesktop from './ide/IdeDesktop';
import MobileApp from './mobile/MobileApp';

const AT = 'att_rt_a';
const STEPS = [
  { who: 'PC', title: 'At the PC — Claude works on “Agent Runtime”', text: 'You direct the work from the ADE. The Attempt runs on Desktop-PC, in its own worktree, with two instructions already queued.', apply: () => {} },
  { who: 'PC', title: 'You leave home. The agent keeps going', text: 'On Desktop-PC the agent reaches a boundary: it wants to install a native dependency. The ADE gets an Attention item — it does NOT steal focus from whatever you were doing — and the phone gets a push.', apply: (s) => s.requestPermission(AT) },
  { who: 'Mobile', title: 'Mobile: you see Attention', text: 'You open the push. The sheet shows Task, agent, host, exact command, risk, reason and the scope you would grant.', apply: (s) => { const x = useStore.getState().attention.find((i) => i.attemptId === AT && i.kind === 'permission'); s.dismissPush(); s.mOpen('approval', { id: x?.id }); } },
  { who: 'Mobile', title: 'You approve once', text: 'The decision goes to the host. Nothing runs on the phone. The approval is scoped to “this command once”, not “always”.', apply: (s) => { const x = useStore.getState().attention.find((i) => i.attemptId === AT && i.kind === 'permission'); if (x) s.resolveAttention(x.id, 'allow_once', { from: 'Mobile' }); } },
  { who: 'PC', title: 'Claude continues on the PC', text: 'The Attempt timeline records who decided and from where. The agent resumes — same Task, same Attempt, same branch.', apply: (s) => { s.addEvent(AT, { kind: 'tools', title: 'Ran 3 commands', items: [{ cmd: 'npm install better-sqlite3', ok: true, ms: 6400 }, { cmd: 'npm run test:integration', ok: true, ms: 27000 }, { cmd: 'git commit -m "runtime: event store"', ok: true, ms: 140 }] }); s.addEvent(AT, { kind: 'check', name: 'Integration tests', status: 'pass', detail: '34 / 34' }); s.simulate(AT, { latest: 'Integration tests passed · finishing' }); } },
  { who: 'PC', title: 'Back at the PC — ADE shows Review ready', text: 'The sidebar row turns purple (Review ready) and a review item appears in Attention. You decide when to look: nothing jumped to the front.', apply: (s) => { s.simulate(AT, { state: 'review_ready', phase: undefined, latest: 'Done · Proof Pack ready', files: 11, add: 612, del: 96, tests: { pass: 150, total: 150 } }); s.raiseAttention({ kind: 'review', attemptId: AT, risk: 'medium', title: 'Review ready · Agent Runtime · Attempt A', summary: '11 files · +612 / −96 · tests 150/150' }); s.feed('Claude finished Agent Runtime — Review ready', AT, 'review'); s.select(AT, 'proof'); } },
  { who: 'IDE', title: 'You open the IDE and inspect the changes', text: 'Open in IDE keeps the identity: Task → Attempt → worktree → host stay pinned in the context bar, so you cannot mistake the branch.', apply: (s) => { s.select(AT); s.setView('workspace'); } },
];

export default function Continuity() {
  const s = useStore();
  const [step, setStep] = useState(0);
  const go = (n) => {
    const st = useStore.getState();
    st.resetAll();
    useStore.getState().select(AT);
    for (let i = 1; i <= n; i += 1) STEPS[i].apply(useStore.getState());
    setStep(n);
  };
  const cur = STEPS[step];
  const pc = step === 6 ? 'ide' : 'ade';
  return (
    <div className="flow">
      <ol className="flow__steps">
        {STEPS.map((x, i) => (
          <li key={x.title}><button type="button" className={`${i === step ? 'is-on' : ''} ${i < step ? 'is-done' : ''}`} onClick={() => go(i)}>
            <span className="flow__n">{i < step ? '✓' : i + 1}</span><span className="flow__who">{x.who}</span><span className="trunc">{x.title.replace(/^[^—:]*[—:]\s*/, '')}</span></button></li>
        ))}
      </ol>
      <div className="flow__cap">
        <span className={`chip chip--tag ${cur.who === 'Mobile' ? 'chip--merged' : cur.who === 'IDE' ? 'chip--accent' : ''}`}>{cur.who}</span>
        <b>{cur.title}</b><span className="muted">{cur.text}</span>
        <span className="sp" />
        <button type="button" className="btn btn--ghost btn--sm" disabled={step === 0} onClick={() => go(step - 1)}>Back</button>
        <button type="button" className="btn btn--accent btn--sm" disabled={step === STEPS.length - 1} onClick={() => go(step + 1)}>Next <I n="arrow" size={12} /></button>
      </div>
      <div className="flow__stage">
        <div className={`flow__pc ${cur.who !== 'Mobile' ? 'is-focus' : ''}`}><Scaled w={1440} h={880}>{pc === 'ide' ? <IdeDesktop live={false} /> : <AdeDesktop live={false} />}</Scaled><span className="flow__lab">{pc === 'ide' ? 'Desktop IDE · Desktop-PC' : 'Desktop ADE · Desktop-PC'}</span></div>
        <div className={`flow__ph ${cur.who === 'Mobile' ? 'is-focus' : ''}`}><Scaled w={408} h={818}><div style={{ padding: 9 }}><MobileApp live /></div></Scaled><span className="flow__lab">Phone · remote control</span></div>
      </div>
    </div>
  );
}
