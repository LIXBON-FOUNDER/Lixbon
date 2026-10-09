// RemoteSessionList.js — filas de las sesiones remotas abiertas: el agente en
// una ficha de 28px, título, de dónde viene y un punto que late mientras el
// host está conectado. La usan el menú lateral y la sección Remoto.
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import { agentOf, isOnline, timeAgo } from '../remoteSessions';
import { FONTS, RADIUS, RADIUS_SM } from '../theme';
import { AgentMark, Breathe, Eyebrow, FadeUp, agentStyle, useColors } from './ui';

const SOURCE_LABEL = { cli: 'CLI', ide: 'IDE' };

export function LiveDot({ size = 7, color }) {
  const c = useColors();
  return <Breathe from={0.35} to={1} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color || c.accent }} />;
}

function subtitle(session, a) {
  if (!isOnline(session)) return [`${a.label} · sin conexión`, timeAgo(session.last_seen_at, true)].filter(Boolean).join(' · ');
  const where = session.workspace || SOURCE_LABEL[session.source] || '';
  return [a.label, where].filter(Boolean).join(' · ');
}

export function SessionRow({ session, active = false, onPress }) {
  const c = useColors();
  const agent = agentOf(session);
  const a = agentStyle(agent, c);
  const online = isOnline(session);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 54,
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: RADIUS,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: active ? c.surface3 : pressed ? c.pressed : 'transparent',
      })}
    >
      <View style={{ width: 28, height: 28, borderRadius: RADIUS_SM, backgroundColor: a.soft, alignItems: 'center', justifyContent: 'center', opacity: online ? 1 : 0.6 }}>
        <AgentMark agent={agent} size={agent === 'claude' ? 15 : 17} />
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 14.5, color: online ? c.ink : c.inkBody }}>
          {session.title || 'Sesión remota'}
        </Text>
        <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>
          {subtitle(session, a)}
        </Text>
      </View>
      {online && <LiveDot />}
    </Pressable>
  );
}

export default function RemoteSessionList({ sessions, activeId, onOpen }) {
  return (
    <FadeUp delay={80} style={{ gap: 2 }}>
      <Eyebrow style={{ paddingHorizontal: 12, marginBottom: 4 }}>En curso</Eyebrow>
      {sessions.map((sx) => (
        <SessionRow key={sx.id} session={sx} active={sx.id === activeId} onPress={() => onOpen(sx)} />
      ))}
    </FadeUp>
  );
}
