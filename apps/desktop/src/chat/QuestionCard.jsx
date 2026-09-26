// QuestionCard.jsx — preguntas del agente (ask_user) sobre la caja de entrada.
// Una pestaña por pregunta; las teclas 1-9 eligen opción y Enter avanza.
import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../store/chatStore';
import { IconCheck, IconChevronLeft, IconChevronRight } from '../components/Icons';

const OTHER = '__other__';

export function QuestionCard() {
  const pending = useChatStore((s) => s.pendingQuestion);
  if (!pending) return null;
  return <Questions key={pending.questions.map((q) => q.question).join('|')} questions={pending.questions} />;
}

function Questions({ questions }) {
  const answer = useChatStore((s) => s.answerQuestion);
  const stop = useChatStore((s) => s.stop);
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState(() => questions.map(() => []));
  const [other, setOther] = useState(() => questions.map(() => ''));
  const rootRef = useRef(null);
  const otherRef = useRef(null);

  const q = questions[step];
  const sel = picked[step];
  const last = step === questions.length - 1;
  const answered = (i) => picked[i].some((v) => v !== OTHER) || (picked[i].includes(OTHER) && other[i].trim());
  const allAnswered = questions.every((_, i) => answered(i));

  useEffect(() => { rootRef.current?.focus(); }, []);
  useEffect(() => { if (sel.includes(OTHER)) otherRef.current?.focus(); }, [sel, step]);

  const setSel = (next) => setPicked((p) => p.map((v, i) => (i === step ? next : v)));

  const submit = () => {
    if (!allAnswered) return;
    answer(questions.map((_, i) => picked[i].map((v) => (v === OTHER ? other[i].trim() : v)).filter(Boolean)));
  };

  const next = () => {
    if (!answered(step)) return;
    if (last) submit();
    else setStep(step + 1);
  };

  const choose = (value) => {
    if (q.multiSelect) {
      setSel(sel.includes(value) ? sel.filter((v) => v !== value) : [...sel, value]);
      return;
    }
    setSel([value]);
    if (value !== OTHER && !last) setTimeout(() => setStep((s) => Math.min(s + 1, questions.length - 1)), 140);
  };

  const onKeyDown = (e) => {
    if (e.target.tagName === 'INPUT') {
      if (e.key === 'Enter') { e.preventDefault(); next(); }
      return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= q.options.length + 1) {
      e.preventDefault();
      choose(n <= q.options.length ? q.options[n - 1].label : OTHER);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      next();
    } else if (e.key === 'ArrowRight' && !last) setStep(step + 1);
    else if (e.key === 'ArrowLeft' && step > 0) setStep(step - 1);
  };

  return (
    <div className="askq" ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="askq__head">
        <span className="askq__eyebrow">El agente pregunta</span>
        {questions.length > 1 && (
          <div className="askq__tabs">
            {questions.map((qq, i) => (
              <button key={i} className={`askq__tab ${i === step ? 'is-active' : ''} ${answered(i) ? 'is-done' : ''}`} onClick={() => setStep(i)}>
                {answered(i) && <IconCheck size={11} />}
                {qq.header || `Pregunta ${i + 1}`}
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="askq__question">{q.question}</p>
      {q.multiSelect && <p className="askq__hint">Puedes elegir varias.</p>}

      <div className="askq__opts" role={q.multiSelect ? 'group' : 'radiogroup'}>
        {q.options.map((o, i) => {
          const on = sel.includes(o.label);
          return (
            <button key={o.label} className={`askq__opt ${on ? 'is-on' : ''}`} onClick={() => choose(o.label)} role={q.multiSelect ? 'checkbox' : 'radio'} aria-checked={on}>
              <span className="askq__num">{on ? <IconCheck size={11} /> : i + 1}</span>
              <span className="askq__text">
                <span className="askq__label">{o.label}</span>
                {o.description && <span className="askq__desc">{o.description}</span>}
              </span>
            </button>
          );
        })}
        <div className={`askq__opt askq__opt--other ${sel.includes(OTHER) ? 'is-on' : ''}`} onClick={() => !sel.includes(OTHER) && choose(OTHER)}>
          <span className="askq__num">{sel.includes(OTHER) ? <IconCheck size={11} /> : q.options.length + 1}</span>
          {sel.includes(OTHER) ? (
            <input
              ref={otherRef}
              className="askq__input"
              placeholder="Escribe tu respuesta"
              value={other[step]}
              onChange={(e) => setOther((o) => o.map((v, i) => (i === step ? e.target.value : v)))}
            />
          ) : (
            <span className="askq__label askq__label--dim">Otra respuesta…</span>
          )}
        </div>
      </div>

      <div className="askq__foot">
        <button className="askq__link" onClick={stop}>Detener</button>
        <div className="askq__fill" />
        {questions.length > 1 && (
          <span className="askq__nav">
            <button className="ic" disabled={step === 0} onClick={() => setStep(step - 1)} title="Anterior"><IconChevronLeft size={14} /></button>
            <span className="askq__count">{step + 1}/{questions.length}</span>
            <button className="ic" disabled={last} onClick={() => setStep(step + 1)} title="Siguiente"><IconChevronRight size={14} /></button>
          </span>
        )}
        <button className="pill-btn pill-btn--primary askq__send" disabled={last ? !allAnswered : !answered(step)} onClick={next}>
          {last ? 'Responder' : 'Siguiente'}
        </button>
      </div>
    </div>
  );
}
