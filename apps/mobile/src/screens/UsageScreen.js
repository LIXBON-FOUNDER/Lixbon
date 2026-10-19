// UsageScreen.js — plan vigente con el atajo para mejorarlo, las dos cuotas
// (sesión y semana) en porcentaje grande con cuándo se reinician, y el panal
// de tokens por servicio de los últimos 7 o 30 días.
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Linking, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Polygon, Text as SvgText } from 'react-native-svg';

import { ApiException } from '../api';
import { EASE, FadeUp, Segmented, SkeletonLines, StackHeader, useColors, useReducedMotion } from '../components/ui';
import { HEX_TOKENS, SERVICES, SERVICE_LABEL, cellSize, fmtTokens, layout, serviceCells } from '../honeycomb';
import { useApi } from '../state';
import { FONTS, RADIUS, RADIUS_SM } from '../theme';

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const pad = (n) => String(n).padStart(2, '0');

// La sesión dura 4 h: para resets cercanos importa "en cuánto", para los
// lejanos el día y la hora.
export function fmtReset(iso) {
  if (typeof iso !== 'string') return 'Empieza con tu próximo mensaje';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.round((d.getTime() - Date.now()) / 60000);
  if (mins <= 0) return 'Se reinicia en un momento';
  if (mins < 60) return `Se reinicia en ${mins} min`;
  if (mins < 24 * 60) return `Se reinicia en ${Math.floor(mins / 60)} h ${mins % 60} min`;
  return `Se reinicia el ${WEEKDAYS[d.getDay()]} a las ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
            <ServiceComb rows={data.services} />
          </FadeUp>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

export function GrowBar({ ratio, color, delay = 0, vertical = false, style }) {
  const reduced = useReducedMotion();
  const anim = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: 1, duration: reduced ? 0 : 900, delay: reduced ? 0 : delay, easing: EASE, useNativeDriver: false }).start();
  }, [anim, delay, reduced]);
  const size = anim.interpolate({ inputRange: [0, 1], outputRange: ['0%', `${Math.max(0, Math.min(1, ratio)) * 100}%`] });
  return <Animated.View style={[vertical ? { height: size } : { width: size }, { backgroundColor: color }, style]} />;
}

export function Quota({ label, bucket, accent = false, delay = 0 }) {
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

// Un color por servicio; sobre papel claro, el mismo tono más oscuro.
const SERVICE_COLORS = {
  dark: { cli: '#B4C64E', ide: '#6FA8F0', mobile: '#F29A6E', web: '#C5B5FF', other: '#5E5E5C' },
  light: { cli: '#7E9430', ide: '#2F6FB0', mobile: '#C0573F', web: '#7A63D6', other: '#B5AC98' },
};

function ServiceComb({ rows }) {
  const c = useColors();
  const [days, setDays] = useState(7);
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState(null);
  const colors = SERVICE_COLORS[c.dark ? 'dark' : 'light'];
  const { cells, hidden, totals, total } = serviceCells(rows, days);
  const s = cellSize(cells.length, width);
  const comb = layout(cells, s);
  const showDay = s >= 9;
  const detail = picked && cells.includes(picked.cell) ? picked.cell : null;
  const used = SERVICES.filter((x) => totals[x] > 0);

  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontFamily: FONTS.ui, fontSize: 14.5, color: c.ink }}>Tokens por servicio</Text>
          <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>{`${fmtTokens(total)} en ${days} días`}</Text>
        </View>
        <Segmented
          size="sm"
          value={days}
          onChange={(v) => {
            setDays(v);
            setPicked(null);
          }}
          options={[
            { value: 7, label: '7 días' },
            { value: 30, label: '30 días' },
          ]}
        />
      </View>

      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ alignItems: 'center', paddingVertical: 4 }}>
        {cells.length === 0 ? (
          <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted, paddingVertical: 24 }}>Sin uso en estos días</Text>
        ) : (
          width > 0 && (
            <Svg
              width={comb.width}
              height={comb.height}
              accessibilityRole="image"
              accessibilityLabel={`Panal de uso: ${used.map((x) => `${SERVICE_LABEL[x]} ${fmtTokens(totals[x])}`).join(', ')}.`}
            >
              {comb.hexes.map((h) => {
                const color = colors[h.cell.service];
                const on = detail === h.cell;
                return (
                  <React.Fragment key={h.key}>
                    <Polygon
                      points={h.points}
                      fill={color}
                      fillOpacity={h.full ? 1 : 0.22}
                      stroke={on ? c.ink : 'none'}
                      strokeWidth={on ? 1.5 : 0}
                      onPress={() => setPicked(on ? null : { cell: h.cell })}
                    />
                    {!h.full && !!h.partial && <Polygon points={h.partial} fill={color} fillOpacity={0.75} onPress={() => setPicked(on ? null : { cell: h.cell })} />}
                    {showDay && (
                      <SvgText
                        x={h.cx}
                        y={h.cy + s * 0.2}
                        fontSize={Math.max(7, s * 0.56)}
                        fontFamily={FONTS.mono}
                        textAnchor="middle"
                        fill={h.full ? (c.dark ? 'rgba(14,14,14,0.68)' : 'rgba(255,255,255,0.9)') : c.ink}
                        onPress={() => setPicked(on ? null : { cell: h.cell })}
                      >
                        {h.cell.day}
                      </SvgText>
                    )}
                  </React.Fragment>
                );
              })}
            </Svg>
          )
        )}
      </View>

      {detail && (
        <Text style={{ textAlign: 'center', fontFamily: FONTS.ui, fontSize: 13, color: c.ink }}>
          {`${SERVICE_LABEL[detail.service]} · ${parseInt(detail.date.slice(8, 10), 10)} ${MONTHS[parseInt(detail.date.slice(5, 7), 10) - 1]} · ${fmtTokens(detail.tokens)}`}
        </Text>
      )}

      {used.length > 0 && (
        <View style={{ gap: 9 }}>
          {used.map((x) => (
            <View key={x} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Svg width={12} height={14}>
                <Polygon points="6,0 12,3.5 12,10.5 6,14 0,10.5 0,3.5" fill={colors[x]} />
              </Svg>
              <Text style={{ flex: 1, fontFamily: FONTS.ui, fontSize: 13, color: c.ink }}>{SERVICE_LABEL[x]}</Text>
              <Text style={{ fontFamily: FONTS.mono, fontSize: 12, color: c.inkMuted }}>{`${Math.ceil(totals[x] / HEX_TOKENS)} hex`}</Text>
              <Text style={{ width: 64, textAlign: 'right', fontFamily: FONTS.mono, fontSize: 12.5, color: c.ink }}>{fmtTokens(totals[x])}</Text>
            </View>
          ))}
        </View>
      )}
      <Text style={{ fontFamily: FONTS.ui, fontSize: 12, lineHeight: 17, color: c.inkMuted }}>
        {`Cada hexágono son 200 mil tokens y lleva el día en que se gastaron. Toca uno para ver el detalle.${totals.other > 0 ? ' «Otros» es lo gastado antes de contar por servicio y con API keys propias.' : ''}${hidden > 0 ? ` Hay ${hidden} hexágonos más que no caben.` : ''}`}
      </Text>
    </>
  );
}
