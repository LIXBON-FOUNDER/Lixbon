// QuestionBatch.js — la tanda de preguntas del agente (ask_user con varias
// preguntas) como una tarjeta con pestañas, igual que en la terminal: una
// pestaña por pregunta, casillas si admite varias y círculos si es una sola,
// «Otra respuesta» escrita en su sitio y un repaso antes de enviar. La tanda
// se responde de una vez con batchValue; lo que quede vacío lo decide el
// agente.
import React, { forwardRef, useImperativeHandle, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import Icon from './Icon';
import { FadeUp, agentStyle, useColors } from './ui';
import { FONTS, RADIUS, RADIUS_SM } from '../theme';

/** La respuesta de una pregunta: lo marcado y lo escrito, separado por comas
    (como el CLI). */
export function answerOf(question, picked, other) {
  const parts = (question.options || []).filter((_, i) => picked?.[i]).map((o) => o.label);
  if ((other || '').trim()) parts.push(other.trim());
  return parts.join(', ');
}

/** Lo que entiende el host: todas las respuestas a la vez y si se cerró sin
    terminar. */
export function batchValue(answers, closed = false) {
  return JSON.stringify(closed ? { answers, closed: true } : { answers });
}

/** Tanda que merece pestañas: más de una pregunta o una de varias opciones. */
export function isBatch(choice) {
  return !!choice?.batch && (choice.batch.length > 1 || choice.batch.some((q) => q.multiple));
}

const QuestionBatch = forwardRef(function QuestionBatch({ choice, agent, onChoose }, ref) {
  const c = useColors();
  const a = agentStyle(agent, c);
  const qs = choice.batch;
  const n = qs.length;
  const [tab, setTab] = useState(0); // n = repaso
  const [picked, setPicked] = useState(() => qs.map(() => ({})));
  const [other, setOther] = useState(() => qs.map(() => ''));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const answers = qs.map((q, i) => answerOf(q, picked[i], other[i]));
  const goTo = (i) => {
    setEditing(false);
    setTab(Math.max(0, Math.min(n, i)));
  };
  const saveOther = (i, text) => {
    setOther((cur) => cur.map((v, j) => (j === i ? text : v)));
    // Con una sola respuesta posible, escribir otra sustituye a la marcada.
    if (!qs[i].multiple && text.trim()) setPicked((cur) => cur.map((p, j) => (j === i ? {} : p)));
  };

  // Lo escrito en el compositor con la tanda abierta es «otra respuesta» de la
  // pregunta que está a la vista.
  useImperativeHandle(ref, () => ({
    answerCurrent(text) {
      const i = Math.min(tab, n - 1);
      saveOther(i, text);
      goTo(i + 1);
    },
  }));

  const pick = (i, j) => {
    const q = qs[i];
    if (q.multiple) {
      setPicked((cur) => cur.map((p, k) => (k === i ? { ...p, [j]: !p[j] } : p)));
      return;
    }
    setPicked((cur) => cur.map((p, k) => (k === i ? { [j]: true } : p)));
    setOther((cur) => cur.map((v, k) => (k === i ? '' : v)));
    goTo(i + 1);
  };

  const send = () => onChoose(choice.id, batchValue(answers));
  const close = () => onChoose(choice.id, answers.some((x) => x) ? batchValue(answers, true) : '');

  const q = tab < n ? qs[tab] : null;
  return (
    <FadeUp accessibilityRole="alert" style={{ marginHorizontal: 12, marginBottom: 8, padding: 14, borderRadius: RADIUS, backgroundColor: c.surface2, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="message" size={14} color={a.ink} strokeWidth={1.7} />
        <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: a.ink }}>{`${a.label} pregunta`}</Text>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>{q ? `· ${tab + 1} de ${n}` : '· repasa'}</Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 6 }}>
        {qs.map((x, i) => {
          const on = i === tab;
          const done = !!answers[i];
          return (
            <Pressable
              key={i}
              onPress={() => goTo(i)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              style={{ height: 32, paddingHorizontal: 10, borderRadius: RADIUS_SM, flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: on ? c.ink : c.bg }}
            >
              {done && !on && <Icon name="tick" size={12} color={c.accentDeep} strokeWidth={2.2} />}
              <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: on ? c.bg : done ? c.accentDeep : c.inkSoft }}>{x.header || `Pregunta ${i + 1}`}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {q ? (
        <>
          <View style={{ gap: 3 }}>
            <Text selectable style={{ fontFamily: FONTS.uiMedium, fontSize: 15, lineHeight: 21, color: c.ink }}>{q.question}</Text>
            {q.multiple && <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>Puedes marcar varias</Text>}
          </View>
          <ScrollView style={{ maxHeight: 300 }} nestedScrollEnabled keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 6 }}>
            {q.options.map((o, j) => {
              const on = !!picked[tab][j];
              return (
                <Pressable
                  key={`${j}${o.label}`}
                  onPress={() => pick(tab, j)}
                  accessibilityRole={q.multiple ? 'checkbox' : 'radio'}
                  accessibilityState={{ checked: on }}
                  style={({ pressed }) => ({ minHeight: 52, paddingHorizontal: 12, paddingVertical: 9, borderRadius: RADIUS_SM, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: on ? c.surface4 : pressed ? c.surface3 : c.bg })}
                >
                  <Mark round={!q.multiple} on={on} />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 14, color: c.ink }}>{o.label}</Text>
                    {!!o.description && <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, lineHeight: 17, color: c.inkMuted }}>{o.description}</Text>}
                  </View>
                </Pressable>
              );
            })}
            {editing ? (
              <View style={{ padding: 10, borderRadius: RADIUS_SM, backgroundColor: c.surface4, gap: 10 }}>
                <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>Otra respuesta</Text>
                <TextInput
                  autoFocus
                  value={draft}
                  onChangeText={setDraft}
                  onSubmitEditing={() => {
                    saveOther(tab, draft);
                    goTo(tab + 1);
                  }}
                  accessibilityLabel="Otra respuesta"
                  placeholder="Escribe tu respuesta"
                  placeholderTextColor={c.inkMuted}
                  style={{ height: 42, borderRadius: RADIUS_SM, paddingHorizontal: 10, backgroundColor: c.bg, color: c.ink, fontFamily: FONTS.ui, fontSize: 14 }}
                />
                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
                  <SmallButton label="Volver a las opciones" onPress={() => setEditing(false)} />
                  <SmallButton
                    primary
                    label="Guardar"
                    onPress={() => {
                      saveOther(tab, draft);
                      goTo(tab + 1);
                    }}
                  />
                </View>
              </View>
            ) : (
              <Pressable
                onPress={() => {
                  setDraft(other[tab]);
                  setEditing(true);
                }}
                accessibilityRole="button"
                style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: 12, borderRadius: RADIUS_SM, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: pressed ? c.surface3 : c.bg })}
              >
                <View style={{ width: 18, alignItems: 'center' }}>
                  <Icon name="pencil" size={13} color={c.inkMuted} strokeWidth={2} />
                </View>
                <Text numberOfLines={2} style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 14, color: other[tab] ? c.ink : c.inkSoft }}>
                  {other[tab] ? `«${other[tab]}»` : 'Otra respuesta…'}
                </Text>
              </Pressable>
            )}
          </ScrollView>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label="Anterior" disabled={tab === 0} onPress={() => goTo(tab - 1)} />
            <Button primary label={tab === n - 1 ? 'Repasar' : 'Siguiente'} onPress={() => goTo(tab + 1)} />
          </View>
        </>
      ) : (
        <>
          <View style={{ gap: 10, paddingVertical: 2 }}>
            {qs.map((x, i) => (
              <Pressable key={i} onPress={() => goTo(i)} accessibilityRole="button" style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
                <Text style={{ fontFamily: FONTS.ui, fontSize: 13, lineHeight: 18, color: c.inkMuted }}>{x.header || `Pregunta ${i + 1}`}</Text>
                <Text style={{ flexShrink: 1, textAlign: 'right', fontFamily: FONTS.ui, fontSize: 13, lineHeight: 18, color: answers[i] ? (other[i] ? c.ink70 : c.ink) : c.warn }}>
                  {answers[i] ? answers[i] : 'Sin responder · elegir'}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>Lo que quede sin responder lo decide el agente.</Text>
          <View style={{ gap: 6 }}>
            <Button primary label="Enviar respuestas" onPress={send} />
            <Pressable onPress={close} accessibilityRole="button" style={{ height: 40, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontFamily: FONTS.ui, fontSize: 13.5, color: c.inkSoft }}>Cerrar sin responder</Text>
            </Pressable>
          </View>
        </>
      )}
    </FadeUp>
  );
});

export default QuestionBatch;

function Mark({ round, on }) {
  const c = useColors();
  return (
    <View style={{ width: 18, height: 18, borderRadius: round ? 9 : 5, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.accent : c.surface5 }}>
      {on && (round ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: c.onAccent }} /> : <Icon name="tick" size={11} color={c.onAccent} strokeWidth={3} />)}
    </View>
  );
}

function Button({ label, onPress, primary = false, disabled = false }) {
  const c = useColors();
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => ({ flex: 1, height: 44, borderRadius: RADIUS_SM, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : 1, backgroundColor: primary ? c.primary : pressed ? c.surface5 : c.raised })}
    >
      <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 14, color: primary ? c.onPrimary : c.onRaised }}>{label}</Text>
    </Pressable>
  );
}

function SmallButton({ label, onPress, primary = false }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({ height: 36, paddingHorizontal: 12, borderRadius: RADIUS_SM, alignItems: 'center', justifyContent: 'center', backgroundColor: primary ? c.primary : pressed ? c.surface5 : c.raised })}
    >
      <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 13, color: primary ? c.onPrimary : c.onRaised }}>{label}</Text>
    </Pressable>
  );
}
