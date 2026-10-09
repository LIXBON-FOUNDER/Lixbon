// AppearanceScreen.js — Personalizar: una muestra del chat que cambia en vivo,
// el color de acento, la lectura (tamaño y densidad) y los detalles de la
// interfaz. Todo se aplica al instante; "Restablecer" vuelve a lo de fábrica.
import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Icon from '../components/Icon';
import { FadeUp, Row, Section, Segmented, StackHeader, Toggle, useColors, useScale } from '../components/ui';
import { usePrefs } from '../state';
import { ACCENTS, FONTS, RADIUS, RADIUS_SM } from '../theme';

function Preview() {
  const c = useColors();
  const { t, s } = useScale();
  return (
    <FadeUp style={{ paddingVertical: 18, paddingHorizontal: 16, borderRadius: RADIUS, backgroundColor: c.sheet, gap: s(12) }}>
      <View style={{ alignSelf: 'flex-end', maxWidth: '80%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: RADIUS, backgroundColor: c.raised }}>
        <Text style={{ fontFamily: FONTS.ui, fontSize: t(14), color: c.onRaised }}>¿Me resumes el contrato?</Text>
      </View>
      <Text style={{ fontFamily: FONTS.ui, fontSize: t(14), lineHeight: t(21), color: c.inkBody }}>
        Claro. Son 4 páginas: duración de 12 meses, pago mensual y una cláusula de salida con 30 días de aviso.
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ height: 28, paddingHorizontal: 10, borderRadius: RADIUS_SM, justifyContent: 'center', backgroundColor: `rgba(${c.accentRgb},0.12)` }}>
          <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 12.5, color: c.accent }}>Web</Text>
        </View>
        <View style={{ flex: 1 }} />
        <View style={{ width: 32, height: 32, borderRadius: RADIUS_SM, alignItems: 'center', justifyContent: 'center', backgroundColor: c.accent }}>
          <Icon name="arrow-up" size={16} color={c.onAccent} strokeWidth={1.8} />
        </View>
      </View>
    </FadeUp>
  );
}

function Stacked({ title, children }) {
  const c = useColors();
  return (
    <View style={{ paddingVertical: 10, paddingHorizontal: 14, gap: 10 }}>
      <Text style={{ fontFamily: FONTS.ui, fontSize: 15, color: c.ink }}>{title}</Text>
      {children}
    </View>
  );
}

export default function AppearanceScreen({ onBack }) {
  const c = useColors();
  const prefs = usePrefs();
  const ui = prefs.ui;
  const set = prefs.setUi;
  const current = ACCENTS.find((a) => a.id === ui.accent) || ACCENTS[0];

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <StackHeader
        title="Personalizar"
        onBack={onBack}
        right={
          <Pressable onPress={prefs.resetUi} style={({ pressed }) => ({ height: 44, paddingHorizontal: 12, borderRadius: RADIUS, justifyContent: 'center', backgroundColor: pressed ? c.pressed : 'transparent' })}>
            <Text style={{ fontFamily: FONTS.ui, fontSize: 14, color: c.ink70 }}>Restablecer</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 28, gap: 24 }}>
        <Preview />

        <FadeUp delay={40} style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4 }}>
            <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 12.5, color: c.inkMuted }}>Color de acento</Text>
            <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 12.5, color: c.inkBody }}>{current.label}</Text>
          </View>
          <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, padding: 12, borderRadius: RADIUS, backgroundColor: c.sheet }}>
            {ACCENTS.map((a) => {
              const on = ui.accent === a.id;
              const color = c.dark ? a.dark[0] : a.light[0];
              return (
                <Pressable
                  key={a.id}
                  onPress={() => set({ accent: a.id })}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={a.label}
                  style={({ pressed }) => ({ flex: 1, aspectRatio: 1, transform: [{ scale: pressed ? 0.92 : 1 }] })}
                >
                  <View style={{ flex: 1, padding: on ? 2 : 0, borderRadius: RADIUS + 2, borderWidth: on ? 2 : 0, borderColor: color }}>
                    <View style={{ flex: 1, borderRadius: on ? RADIUS - 2 : RADIUS, backgroundColor: color }} />
                  </View>
                </Pressable>
              );
            })}
          </View>
        </FadeUp>

        <Section title="Lectura" delay={80}>
          <Stacked title="Tamaño del texto">
            <Segmented
              stretch
              size="xl"
              value={ui.textSize}
              onChange={(textSize) => set({ textSize })}
              options={[
                { value: 'sm', label: 'Aa', size: 13, a11y: 'Pequeño' },
                { value: 'md', label: 'Aa', size: 15, a11y: 'Normal' },
                { value: 'lg', label: 'Aa', size: 18, a11y: 'Grande' },
              ]}
            />
          </Stacked>
          <Stacked title="Densidad">
            <Segmented
              stretch
              size="xl"
              value={ui.density}
              onChange={(density) => set({ density })}
              options={[
                { value: 'compact', label: 'Compacta' },
                { value: 'normal', label: 'Normal' },
                { value: 'roomy', label: 'Amplia' },
              ]}
            />
          </Stacked>
        </Section>

        <Section title="Interfaz" delay={120}>
          <Row title="Animaciones" detail="Transiciones lentas y suaves" right={<Toggle label="Animaciones" value={ui.motion} onChange={(motion) => set({ motion })} />} />
          <Row title="Luz ambiente" detail="Halo tenue del acento en el fondo" right={<Toggle label="Luz ambiente" value={ui.ambient} onChange={(ambient) => set({ ambient })} />} />
          <Row title="Barra de estado" detail="Contexto usado bajo el compositor" right={<Toggle label="Barra de estado" value={ui.statusBar} onChange={(statusBar) => set({ statusBar })} />} />
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}
