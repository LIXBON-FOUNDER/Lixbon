// App.js — raíz de la app móvil de Lixbon: wiring de estado (prefs, sesión,
// chat), tema claro/oscuro con los tokens de la marca y gate de autenticación
// → pestañas (Chat, Historial, Uso, Cuenta) con una tab bar propia.
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import Icon from './src/components/Icon';
import { DialogProvider } from './src/components/dialogs';
import {
  LixLogo,
  ThemeProvider,
  useColors,
  useIsDark,
  useReducedMotion,
} from './src/components/ui';
import AccountScreen from './src/screens/AccountScreen';
import AuthScreen from './src/screens/AuthScreen';
import ChatScreen from './src/screens/ChatScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import UsageScreen from './src/screens/UsageScreen';
import { AppState, useAuth } from './src/state';
import { FONTS, LIGHT, RADIUS_PILL } from './src/theme';

export default function App() {
  const [fontsLoaded] = useFonts({
    [FONTS.brand]: require('./assets/fonts/BrunoAceSC-Regular.ttf'),
    [FONTS.ui]: require('./assets/fonts/BricolageGrotesque-Regular.ttf'),
    [FONTS.uiMedium]: require('./assets/fonts/BricolageGrotesque-Medium.ttf'),
    [FONTS.uiSemiBold]: require('./assets/fonts/BricolageGrotesque-SemiBold.ttf'),
    [FONTS.uiBold]: require('./assets/fonts/BricolageGrotesque-Bold.ttf'),
  });

  if (!fontsLoaded) {
    // Sin fuentes aún no hay wordmark: solo el crema de fondo.
    return <View style={{ flex: 1, backgroundColor: LIGHT.bgSecondary }} />;
  }

  return (
    <SafeAreaProvider>
      <AppState>
        <ThemeProvider>
          <DialogProvider>
            <Root />
          </DialogProvider>
        </ThemeProvider>
      </AppState>
    </SafeAreaProvider>
  );
}

function Root() {
  const c = useColors();
  const dark = useIsDark();
  const auth = useAuth();

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <StatusBar style={dark ? 'light' : 'dark'} />
      {!auth.ready ? <Splash /> : auth.apiKey ? <HomeShell /> : <AuthScreen />}
    </View>
  );
}

// Pantalla de carga (.app-loading de la web): wordmark pulsando sobre crema.
function Splash() {
  const c = useColors();
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reduced) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.45, duration: 800, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduced]);

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: c.bgSecondary,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 26,
      }}
    >
      <Animated.View style={{ opacity: pulse }}>
        <LixLogo size={30} />
      </Animated.View>
      {reduced && <ActivityIndicator color={c.inkSoft} />}
    </View>
  );
}

const TABS = [
  { key: 'chat', label: 'Chat', icon: 'chat' },
  { key: 'history', label: 'Historial', icon: 'history' },
  { key: 'usage', label: 'Uso', icon: 'chart' },
  { key: 'account', label: 'Cuenta', icon: 'user' },
];

function HomeShell() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState('chat');

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ flex: 1 }}>
        {tab === 'chat' && <ChatScreen />}
        {tab === 'history' && <HistoryScreen onOpenChat={() => setTab('chat')} />}
        {tab === 'usage' && <UsageScreen />}
        {tab === 'account' && <AccountScreen />}
      </View>

      <View
        style={{
          flexDirection: 'row',
          backgroundColor: c.bgSidebar,
          borderTopWidth: 1,
          borderTopColor: c.borderSoft,
          paddingTop: 8,
          paddingBottom: Math.max(insets.bottom, 10),
          paddingHorizontal: 6,
        }}
      >
        {TABS.map(({ key, label, icon }) => {
          const active = tab === key;
          return (
            <Pressable
              key={key}
              onPress={() => setTab(key)}
              style={{ flex: 1, alignItems: 'center', gap: 3 }}
            >
              <View
                style={{
                  paddingHorizontal: 18,
                  paddingVertical: 4,
                  borderRadius: RADIUS_PILL,
                  backgroundColor: active ? c.accentSoft : 'transparent',
                }}
              >
                <Icon
                  name={icon}
                  size={21}
                  color={active ? c.ink : c.inkMuted}
                  strokeWidth={active ? 2 : 1.7}
                />
              </View>
              <Text
                style={{
                  fontFamily: active ? FONTS.uiMedium : FONTS.ui,
                  fontSize: 11,
                  color: active ? c.ink : c.inkSoft,
                }}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
