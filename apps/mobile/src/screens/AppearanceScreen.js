// AppearanceScreen.js — personalización de la interfaz: tema, acento,
// tamaño del texto, densidad, envío, barra de estado, luz ambiente y
// animaciones. Todo se aplica al instante y se ve en la muestra de arriba.
import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Icon from '../components/Icon';
import {
  AmbientGlow,
  Card,
  CardTitle,
  Eyebrow,
  LogoMark,
  PillButton,
  Segmented,
  StackHeader,
  Toggle,
  useColors,
  useScale,
} from '../components/ui';
import { usePrefs } from '../state';
import { ACCENTS, FONTS, RADIUS } from '../theme';

function Row({ label, hint, children, stacked = false }) {
  const c = useColors();
  return (
    <View
      style={{
        flexDirection: stacked ? 'column' : 'row',
        alignItems: stacked ? 'stretch' : 'center',
        gap: stacked ? 10 : 12,
        paddingVertical: 12,
        paddingHorizontal: 12,
        borderRadius: RADIUS,
        backgroundColor: c.pressed,
      }}
    >
      <View style={[{ gap: 2 }, !stacked && { flex: 1 }]}>
        <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 14, color: c.ink }}>{label}</Text>
        {!!hint && <Text style={{ fontFamily: FONTS.ui, fontSize: 12, lineHeight: 17, color: c.inkMuted }}>{hint}</Text>}
      </View>
      {children}
    </View>
  );
}

function Preview() {
  const c = useColors();
  const { t, s } = useScale();
  return (
    <View style={{ borderRadius: RADIUS, overflow: 'hidden', backgroundColor: c.surface0, padding: 6, gap: 5 }}>
      <AmbientGlow />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 24, paddingHorizontal: 4 }}>
        <LogoMark size={15} />
        <View style={{ flex: 1, alignItems: 'center' }}>
          <View style={{ flexDirection: 'row', padding: 2, borderRadius: 5, backgroundColor: c.surface1 }}>
            <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 9.5, color: c.ink, paddingHorizontal: 8, paddingVertical: 1, borderRadius: 4, backgroundColor: c.surface5 }}>Chat</Text>
            <Text style={{ fontFamily: FONTS.ui, fontSize: 9.5, color: c.inkMuted, paddingHorizontal: 8, paddingVertical: 1 }}>Remoto</Text>
          </View>
        </View>
        <View style={{ width: 13, height: 13, borderRadius: 4, backgroundColor: c.primary }} />
      </View>
      <View style={{ borderRadius: 5, backgroundColor: c.surface1, padding: 10, gap: s(8) }}>
        <View style={{ alignSelf: 'flex-end', maxWidth: '80%', paddingHorizontal: 9, paddingVertical: 6, borderRadius: 5, backgroundColor: c.surface3 }}>
          <Text style={{ fontFamily: FONTS.ui, fontSize: t(12), color: c.ink }}>¿Qué tal se ve esto?</Text>
        </View>
        <Text style={{ fontFamily: FONTS.ui, fontSize: t(12.5), lineHeight: t(18), color: c.inkBody }}>
          Así se verán tus conversaciones. El <Text style={{ fontFamily: FONTS.mono, color: c.accentDeep }}>código</Text> va en mono.
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 26, paddingLeft: 9, paddingRight: 4, borderRadius: 6, backgroundColor: c.surface3 }}>
          <View style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: c.surface5, maxWidth: '45%' }} />
          <View style={{ flex: 1 }} />
          <View style={{ width: 18, height: 18, borderRadius: 5, backgroundColor: c.primary }} />
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 4, height: 14 }}>
        <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: c.accent }} />
        <Text style={{ fontFamily: FONTS.mono, fontSize: 9, color: c.inkLabel }}>listo · qwen3.5 · ctx 2.4k/32k</Text>
      </View>
    </View>
  );
}

export default function AppearanceScreen({ onBack }) {
  const c = useColors();
  const prefs = usePrefs();
  const ui = prefs.ui;
  const set = prefs.setUi;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <StackHeader title="Personalizar" onBack={onBack} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: 40, gap: 10 }}>
        <Card style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1, gap: 2 }}>
              <CardTitle>Tu Lixbon</CardTitle>
              <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, color: c.inkMuted }}>Se guarda en este teléfono y se aplica al instante.</Text>
            </View>
          </View>
          <Preview />
        </Card>

        <Card style={{ gap: 6 }}>
          <Eyebrow style={{ marginBottom: 4 }}>Apariencia</Eyebrow>
          <Row label="Tema" hint="Sistema sigue el ajuste del teléfono" stacked>
            <Segmented
              stretch
              value={prefs.themeMode}
              onChange={prefs.setThemeMode}
              options={[
                { value: 'dark', label: 'Oscuro' },
                { value: 'light', label: 'Claro' },
                { value: 'system', label: 'Sistema' },
              ]}
            />
          </Row>
          <Row label="Color de acento" hint="Marca el estado: foco, selección, progreso" stacked>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
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
                    style={({ pressed }) => ({
                      padding: 3,
                      borderRadius: RADIUS + 2,
                      borderWidth: 2,
                      borderColor: on ? color : 'transparent',
                      transform: [{ scale: pressed ? 0.9 : 1 }],
                    })}
                  >
                    <View style={{ width: 30, height: 30, borderRadius: RADIUS, backgroundColor: color, alignItems: 'center', justifyContent: 'center' }}>
                      {on && <Icon name="check" size={14} color={c.dark ? '#0B0B0B' : '#FFFFFF'} strokeWidth={2.4} />}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </Row>
        </Card>

        <Card style={{ gap: 6 }}>
          <Eyebrow style={{ marginBottom: 4 }}>Chat</Eyebrow>
          <Row label="Tamaño del texto" hint="Respuestas y tus mensajes" stacked>
            <Segmented
              stretch
              value={ui.textSize}
              onChange={(textSize) => set({ textSize })}
              options={[
                { value: 'sm', label: 'Pequeño' },
                { value: 'md', label: 'Normal' },
                { value: 'lg', label: 'Grande' },
              ]}
            />
          </Row>
          <Row label="Densidad" hint="Aire entre mensajes y filas del historial" stacked>
            <Segmented
              stretch
              value={ui.density}
              onChange={(density) => set({ density })}
              options={[
                { value: 'compact', label: 'Compacta' },
                { value: 'normal', label: 'Normal' },
                { value: 'roomy', label: 'Amplia' },
              ]}
            />
          </Row>
          <Row label="Enviar con Enter" hint="Útil con teclado físico; si no, Enter salta de línea">
            <Toggle label="Enviar con Enter" value={ui.sendOnEnter} onChange={(sendOnEnter) => set({ sendOnEnter })} />
          </Row>
          <Row label="Barra de estado" hint="Modelo, búsqueda web y contexto bajo el compositor">
            <Toggle label="Barra de estado" value={ui.statusBar} onChange={(statusBar) => set({ statusBar })} />
          </Row>
        </Card>

        <Card style={{ gap: 6 }}>
          <Eyebrow style={{ marginBottom: 4 }}>Espacio de trabajo</Eyebrow>
          <Row label="Luz ambiente" hint="El halo suave del fondo, igual que en el IDE">
            <Toggle label="Luz ambiente" value={ui.ambient} onChange={(ambient) => set({ ambient })} />
          </Row>
          <Row label="Animaciones" hint="Apágalas si prefieres una interfaz quieta">
            <Toggle label="Animaciones" value={ui.motion} onChange={(motion) => set({ motion })} />
          </Row>
        </Card>

        <View style={{ alignItems: 'flex-start', paddingHorizontal: 4, paddingTop: 4 }}>
          <PillButton label="Restablecer" outline icon="refresh" onPress={prefs.resetUi} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
