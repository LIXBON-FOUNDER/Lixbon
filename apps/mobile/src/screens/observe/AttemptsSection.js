// AttemptsSection.js — los intentos de una Task en su detalle (LXO-126, solo lectura).
//
// Lista compacta, no un árbol: una fila por intento con su número, proveedor, estado, edad y resultado. El que
// pide atención va primero y resaltado (si ninguno, el actual); el resto sigue debajo, del más nuevo al más viejo,
// con un filtro Todos / En curso / Terminados. Host y origen salen en cada fila solo si cambian entre intentos.
// Tocar una fila abre ese intento: nunca se elige «el último» por el usuario.
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import Icon from '../../components/Icon';
import { Eyebrow, Segmented, useColors } from '../../components/ui';
import { ageText, categoryOf } from '../../observe/attention';
import { attemptA11y, attemptFilterOptions, attemptsModel, attemptsNotice, originText } from '../../observe/attempts';
import { Body, Notice, StateText } from '../../observe/ui';
import { FONTS, RADIUS } from '../../theme';

export function AttemptRow({ item, now, showPlace, highlighted, onOpen }) {
  const c = useColors();
  const flag = item.attention[0];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={attemptA11y(item, now, showPlace)}
      accessibilityHint="Abre este intento"
      onPress={() => onOpen(item)}
      style={({ pressed }) => ({
        minHeight: 56,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: RADIUS,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: pressed ? c.pressed : highlighted && flag ? c.warnSoft : c.surface2,
      })}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: FONTS.uiMedium, fontSize: 14.5, color: c.ink }}>
            {`Intento ${item.n ?? '?'} · ${item.provider}`}
          </Text>
          {item.current ? <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 11.5, color: c.inkMuted }}>ACTUAL</Text> : null}
        </View>
        <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>
          {[item.model, item.at ? ageText(item.at, now) : null, item.result?.text].filter(Boolean).join(' · ') || 'sin resultado todavía'}
        </Text>
        {showPlace ? (
          <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 12, color: c.inkFaint }}>
            {`${item.host ? `En ${item.host}` : 'Host desconocido'} · ${originText(item.origin)}`}
          </Text>
        ) : null}
        {flag ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name={categoryOf(flag.category).icon} size={13} color={c.warn} />
            <Text numberOfLines={1} style={{ fontFamily: FONTS.uiMedium, fontSize: 12.5, color: c.warn }}>
              {item.attention.length === 1 ? categoryOf(flag.category).label : `${categoryOf(flag.category).label} y ${item.attention.length - 1} más`}
            </Text>
          </View>
        ) : null}
      </View>
      <StateText tone={item.statusMeta.tone}>{item.statusMeta.label}</StateText>
      <Icon name="chevron-right" size={16} color={c.inkFaint} />
    </Pressable>
  );
}

export default function AttemptsSection({ attempts, now, onOpen }) {
  const [filter, setFilter] = useState('all');
  const m = attemptsModel({ data: attempts.data, attention: attempts.attention, filter });
  const notice = attemptsNotice({ data: attempts.data, stale: attempts.stale, at: attempts.at, now, online: attempts.online });

  return (
    <View style={{ gap: 10 }}>
      <Eyebrow>{m ? `Intentos · ${m.count}` : 'Intentos'}</Eyebrow>
      {notice ? <Notice tone={notice.tone} icon="clock">{notice.text}</Notice> : null}
      {m ? (
        <>
          <Body muted>
            {[m.taskState ? `Tarea ${m.taskState.toLowerCase()}` : null, m.flaggedCount ? (m.flaggedCount === 1 ? '1 intento pide atención' : `${m.flaggedCount} intentos piden atención`) : null,
              m.sharedPlace ? `${m.sharedPlace.host ? `en ${m.sharedPlace.host}` : 'host desconocido'} · ${originText(m.sharedPlace.origin).toLowerCase()}` : null]
              .filter(Boolean)
              .join(' · ')}
          </Body>
          {m.empty ? (
            <Body muted>Esta tarea no se ha lanzado todavía: no tiene intentos.</Body>
          ) : (
            <>
              {m.counts.all > 1 ? <Segmented size="sm" options={attemptFilterOptions(m.counts)} value={filter} onChange={setFilter} /> : null}
              {m.items.length === 0 ? (
                <Body muted>{filter === 'active' ? 'Ningún intento sigue en marcha.' : 'Ningún intento ha terminado todavía.'}</Body>
              ) : (
                m.items.map((item) => (
                  <AttemptRow key={item.id} item={item} now={now} showPlace={m.showPlace} highlighted={item.id === m.relevantId} onOpen={onOpen} />
                ))
              )}
              {m.truncated ? <Body muted style={{ fontSize: 12.5 }}>{`Se ven los últimos ${m.counts.all}; los anteriores, en Lixbon Desktop.`}</Body> : null}
              {attempts.attentionPartial && m.flaggedCount ? <Body muted style={{ fontSize: 12.5 }}>Atención: solo la más urgente, de la última sincronización.</Body> : null}
            </>
          )}
        </>
      ) : null}
    </View>
  );
}
