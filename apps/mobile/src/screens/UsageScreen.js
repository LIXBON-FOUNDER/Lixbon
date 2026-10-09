// UsageScreen.js — plan vigente con el atajo para mejorarlo, las dos cuotas
// (sesión y semana) en porcentaje grande con cuándo se reinician, y los
// tokens de los últimos 7 días en barras que crecen al entrar.
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Linking, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiException } from '../api';
import { EASE, FadeUp, SkeletonLines, StackHeader, useColors, useReducedMotion } from '../components/ui';
import { useApi } from '../state';
import { FONTS, RADIUS, RADIUS_SM } from '../theme';

const DAYS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const pad = (n) => String(n).padStart(2, '0');

// La sesión dura 4 h: para resets cercanos importa "en cuánto", para los
// lejanos el día y la hora.
function fmtReset(iso) {
  if (typeof iso !== 'string') return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.round((d.getTime() - Date.now()) / 60000);
  if (mins <= 0) return 'Se reinicia en un momento';
  if (mins < 60) return `Se reinicia en ${mins} min`;
  if (mins < 24 * 60) return `Se reinicia en ${Math.floor(mins / 60)} h ${mins % 60} min`;
  return `Se reinicia el ${WEEKDAYS[d.getDay()]} a las ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function compact(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.0', '')} M`;
  if (n >= 1000) return `${Math.round(n / 1000)} mil`;
  return String(n);
}

export default function UsageScreen({ onBack }) {
  const c = useColors();
  const api = useApi();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      const res = await api.get('/api/account/usage');
      setData(res && typeof res === 'object' ? res : null);
      setError('');
    } catch (err) {
      setError(err instanceof ApiException ? err.message : 'Sin conexión con el servidor');
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const plan = data?.plan && typeof data.plan === 'object' ? data.plan : null;
  const buckets = data?.buckets && typeof data.buckets === 'object' ? data.buckets : null;
  const card = { padding: 16, borderRadius: RADIUS, backgroundColor: c.sheet };

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <StackHeader title="Uso y límites" onBack={onBack} />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 28, gap: 12 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={c.inkSoft}
            colors={[c.ink]}
            progressBackgroundColor={c.surface3}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
      >
        {data == null && !error && (
          <View style={[card, { gap: 22 }]}>
            <SkeletonLines widths={['50%', '100%']} />
            <SkeletonLines widths={['40%', '100%']} />
          </View>
        )}
        {!!error && (
          <View style={{ padding: 14, borderRadius: RADIUS, backgroundColor: c.dangerSoft }}>
            <Text style={{ fontFamily: FONTS.ui, fontSize: 14, color: c.danger }}>{error}</Text>
          </View>
        )}

        {plan && (
          <FadeUp style={[card, { flexDirection: 'row', alignItems: 'center', gap: 12 }]}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 16, color: c.ink }}>Plan {String(plan.name || plan.id || '')}</Text>
              <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>El mismo cupo en web, IDE y móvil</Text>
            </View>
            <Pressable
              onPress={() => Linking.openURL(`${api.base}/plans`)}
              style={({ pressed }) => ({ height: 36, paddingHorizontal: 12, borderRadius: RADIUS_SM, justifyContent: 'center', backgroundColor: pressed ? c.surface5 : c.raised })}
            >
              <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 13.5, color: c.onRaised }}>Mejorar</Text>
            </Pressable>
          </FadeUp>
        )}

        {buckets && (
          <FadeUp delay={50} style={[card, { paddingVertical: 18, gap: 20 }]}>
            <Quota label="Sesión actual" bucket={buckets.session} accent />
            <Quota label="Esta semana" bucket={buckets.week} delay={100} />
          </FadeUp>
        )}

        {data != null && (
          <FadeUp delay={100} style={[card, { paddingTop: 18, paddingBottom: 14, gap: 16 }]}>
            <DailyChart daily={data.daily} />
          </FadeUp>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function GrowBar({ ratio, color, delay = 0, vertical = false, style }) {
  const reduced = useReducedMotion();
  const anim = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: 1, duration: reduced ? 0 : 900, delay: reduced ? 0 : delay, easing: EASE, useNativeDriver: false }).start();
  }, [anim, delay, reduced]);
  const size = anim.interpolate({ inputRange: [0, 1], outputRange: ['0%', `${Math.max(0, Math.min(1, ratio)) * 100}%`] });
  return <Animated.View style={[vertical ? { height: size } : { width: size }, { backgroundColor: color }, style]} />;
}

function Quota({ label, bucket, accent = false, delay = 0 }) {
  const c = useColors();
  if (!bucket || typeof bucket !== 'object') return null;
  const unlimited = !!bucket.unlimited || typeof bucket.percent !== 'number';
  const ratio = unlimited ? 0 : bucket.percent / 100;
  const color = ratio >= 1 ? c.danger : accent ? c.accent : c.inkBody;
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 14.5, color: c.ink }}>{label}</Text>
        <Text style={{ fontFamily: FONTS.uiMedium, fontSize: unlimited ? 15 : 26, letterSpacing: -0.5, color: ratio >= 1 ? c.danger : c.ink }}>
          {unlimited ? 'Ilimitado' : `${Math.round(bucket.percent)}%`}
        </Text>
      </View>
      {!unlimited && (
        <View style={{ height: 6, borderRadius: 3, backgroundColor: c.raised, overflow: 'hidden' }}>
          <GrowBar ratio={ratio} color={color} delay={delay} style={{ height: 6, borderRadius: 3 }} />
        </View>
      )}
      {!!fmtReset(bucket.reset_at) && <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>{fmtReset(bucket.reset_at)}</Text>}
    </View>
  );
}

function DailyChart({ daily }) {
  const c = useColors();
  const byDate = {};
  if (Array.isArray(daily)) {
    for (const row of daily) {
      if (row && typeof row.usage_date === 'string') {
        byDate[row.usage_date] = (byDate[row.usage_date] || 0) + (typeof row.total_tokens === 'number' ? row.total_tokens : 0);
      }
    }
  }
  const today = new Date();
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today.getTime() - (6 - i) * 86400000);
    return { day: DAYS[d.getDay()], tokens: byDate[`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`] || 0 };
  });
  const max = Math.max(1, ...days.map((d) => d.tokens));

  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 14.5, color: c.ink }}>Tokens por día</Text>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>Hoy · {compact(days[6].tokens)}</Text>
      </View>
      <View
        accessibilityRole="image"
        accessibilityLabel={`Tokens de los últimos 7 días. Hoy, ${compact(days[6].tokens)}.`}
        style={{ height: 140, flexDirection: 'row', alignItems: 'flex-end', gap: 10 }}
      >
        {days.map((d, i) => (
          <View key={i} style={{ flex: 1, height: '100%', justifyContent: 'flex-end' }}>
            <GrowBar
              vertical
              delay={i * 40}
              ratio={d.tokens > 0 ? Math.max(0.03, d.tokens / max) : 0.015}
              color={i === 6 ? c.accent : c.surface6}
              style={{ borderRadius: 4 }}
            />
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {days.map((d, i) => (
          <Text key={i} style={{ flex: 1, textAlign: 'center', fontFamily: FONTS.ui, fontSize: 12, color: i === 6 ? c.ink : c.inkMuted }}>
            {d.day}
          </Text>
        ))}
      </View>
    </>
  );
}
