// UsageScreen.js — plan vigente, consumo del período y barras de tokens/día
// (30 días), espejo de "Mi cuenta → Uso" de la web (account.css): página
// crema con tarjetas blancas, cuotas .quota (pista tinta 8 %, relleno tinta,
// danger al llenarse) y gráfico de barras de tinta (.uchart).
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Icon from '../components/Icon';
import { Card, CardTitle, PlanPill, StackHeader, useColors } from '../components/ui';
import { ApiException } from '../api';
import { useApi } from '../state';
import { FONTS, RADIUS_PILL } from '../theme';

function fmtDate(iso) {
  if (typeof iso !== 'string') return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// La sesión dura 4h, así que el reset puede caer el mismo día — sin hora no
// se distingue "se reinicia en 20 min" de "se reinicia mañana".
function fmtDateTime(iso) {
  if (typeof iso !== 'string') return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

  const plan = data?.plan;
  const buckets = data?.buckets;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bgSecondary }}>
      <StackHeader title="Uso" onBack={onBack} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 30, paddingTop: 6 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={c.ink}
            colors={[c.ink]}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
      >
        <View style={{ paddingHorizontal: 16, gap: 14 }}>
          {data == null && !error && (
            <View style={{ paddingTop: 40, alignItems: 'center' }}>
              <ActivityIndicator color={c.inkSoft} />
            </View>
          )}
          {!!error && (
            <Text style={{ fontFamily: FONTS.ui, fontSize: 14, color: c.danger }}>{error}</Text>
          )}

          {plan && typeof plan === 'object' && (
            <Card>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <CardTitle>Plan actual</CardTitle>
                <PlanPill>{String(plan.name || plan.id || '')}</PlanPill>
              </View>
              <Pressable
                onPress={() => Linking.openURL(`${api.base}/planes`)}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 5,
                  marginTop: 10,
                  alignSelf: 'flex-start',
                  opacity: pressed ? 0.72 : 1,
                })}
              >
                <Text
                  style={{
                    fontFamily: FONTS.ui,
                    fontSize: 13.5,
                    color: c.accentDeep,
                    textDecorationLine: 'underline',
                  }}
                >
                  Ver planes y mejoras
                </Text>
                <Icon name="external" size={13} color={c.accentDeep} />
              </Pressable>
            </Card>
          )}

          {buckets && typeof buckets === 'object' && (
            <Card style={{ gap: 18 }}>
              <Quota
                label="Sesión actual"
                hint="Se reinicia cada 4h"
                percent={buckets.session.unlimited ? null : buckets.session.percent}
                resetsAt={buckets.session.reset_at}
                fmtReset={fmtDateTime}
              />
              <Quota
                label="Esta semana"
                hint="El mismo cupo en todas tus apps"
                percent={buckets.week.unlimited ? null : buckets.week.percent}
                resetsAt={buckets.week.reset_at}
                fmtReset={fmtDateTime}
              />
            </Card>
          )}

          {data != null && (
            <Card>
              <CardTitle style={{ marginBottom: 14 }}>Tokens por día</CardTitle>
              <DailyChart daily={data.daily} />
            </Card>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// Cuota (.quota): cabecera etiqueta + %, pista redondeada y relleno de tinta
// que pasa a danger al llenarse. Muestra % en vez de números crudos porque el
// crédito ponderado de sesión/semana es una unidad interna, no algo que el
// usuario deba interpretar en cifras absolutas.
function Quota({ label, hint, percent, resetsAt, fmtReset = fmtDate }) {
  const c = useColors();
  const unlimited = percent == null;
  const ratio = unlimited ? 0 : Math.min(1, Math.max(0, percent / 100));
  const full = !unlimited && ratio >= 1;
  return (
    <View style={{ gap: 7 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 15, color: c.ink }}>{label}</Text>
        <Text
          style={{
            fontFamily: full ? FONTS.uiSemiBold : FONTS.ui,
            fontSize: 14,
            color: full ? c.danger : c.inkSoft,
            fontVariant: ['tabular-nums'],
          }}
        >
          {unlimited ? 'ilimitado' : `${Math.round(percent)}%`}
        </Text>
      </View>
      <View
        style={{
          height: 8,
          borderRadius: RADIUS_PILL,
          backgroundColor: c.track,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            width: `${ratio * 100}%`,
            height: '100%',
            borderRadius: RADIUS_PILL,
            backgroundColor: full ? c.danger : c.ink,
          }}
        />
      </View>
      {hint != null && (
        <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkSoft }}>{hint}</Text>
      )}
      {resetsAt != null && (
        <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkSoft }}>
          Se reinicia el {fmtReset(resetsAt)}
        </Text>
      )}
    </View>
  );
}

// Gráfico de barras (.uchart): barras de tinta, días sin uso en pista suave.
function DailyChart({ daily }) {
  const c = useColors();
  const byDate = {};
  if (Array.isArray(daily)) {
    for (const row of daily) {
      if (row && typeof row.usage_date === 'string') {
        const tokens = typeof row.total_tokens === 'number' ? row.total_tokens : 0;
        byDate[row.usage_date] = (byDate[row.usage_date] || 0) + tokens;
      }
    }
  }
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const data = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(today.getTime() - (29 - i) * 86400000);
    return byDate[`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`] || 0;
  });
  const max = Math.max(1, ...data);
  const CHART_HEIGHT = 110;

  return (
    <View>
      <View style={{ height: CHART_HEIGHT, flexDirection: 'row', alignItems: 'flex-end' }}>
        {data.map((tokens, i) => (
          <View key={i} style={{ flex: 1, paddingHorizontal: 1.5 }}>
            <View
              style={{
                height: tokens > 0 ? Math.max(3, (CHART_HEIGHT * tokens) / max) : 2,
                borderRadius: 2,
                backgroundColor: tokens > 0 ? c.ink : c.track,
              }}
            />
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 11, color: c.inkSoft }}>hace 30 días</Text>
        <Text style={{ fontFamily: FONTS.ui, fontSize: 11, color: c.inkSoft }}>hoy</Text>
      </View>
    </View>
  );
}
