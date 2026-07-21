// App.js — raíz de la app móvil de Lixbon: wiring de estado (prefs, sesión,
// chat), tema claro/oscuro con los tokens de la marca y gate de autenticación.
// Shell tipo Claude/web: el chat es la pantalla principal, un drawer lateral
// (sidebar de la web) lleva historial + perfil, y Uso/Cuenta entran como
// pantallas apiladas deslizándose desde la derecha.
import { useFonts } from 'expo-font';
import * as Linking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, BackHandler, Easing, Pressable, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { DialogProvider } from './src/components/dialogs';
import Sidebar from './src/components/Sidebar';
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
import RemoteScreen from './src/screens/RemoteScreen';
import UsageScreen from './src/screens/UsageScreen';
import { AppState, useAuth } from './src/state';
import { FONTS, LIGHT } from './src/theme';

const EASE = Easing.bezier(0.22, 1, 0.36, 1);

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

function HomeShell() {
  const c = useColors();
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  const drawerWidth = Math.min(width * 0.82, 320);

  // ── Drawer lateral ─────────────────────────────────────────────────────
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawer = useRef(new Animated.Value(0)).current; // 0 cerrado · 1 abierto

  const animateDrawer = useCallback(
    (to) => {
      Animated.timing(drawer, {
        toValue: to,
        duration: reduced ? 0 : 260,
        easing: EASE,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished && to === 0) setDrawerOpen(false);
      });
    },
    [drawer, reduced],
  );

  const openDrawer = useCallback(() => {
    setDrawerOpen(true);
    animateDrawer(1);
  }, [animateDrawer]);

  const closeDrawer = useCallback(() => animateDrawer(0), [animateDrawer]);

  // ── Pantallas apiladas (Uso / Cuenta / Remote) ─────────────────────────
  const [stack, setStack] = useState(null); // null | 'usage' | 'account' | 'remote'
  const [remoteToken, setRemoteToken] = useState(null); // token del deep link /remote/<token>
  const slide = useRef(new Animated.Value(0)).current; // 0 fuera · 1 dentro

  const pushScreen = useCallback(
    (name) => {
      setStack(name);
      closeDrawer();
      Animated.timing(slide, {
        toValue: 1,
        duration: reduced ? 0 : 280,
        easing: EASE,
        useNativeDriver: true,
      }).start();
    },
    [slide, reduced, closeDrawer],
  );

  const popScreen = useCallback(() => {
    Animated.timing(slide, {
      toValue: 0,
      duration: reduced ? 0 : 240,
      easing: EASE,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) {
        setStack(null);
        setRemoteToken(null);
      }
    });
  }, [slide, reduced]);

  // Deep link del QR / control remoto: https://lixbon.com/remote/<token> o
  // lixbon://remote/<token> abre directamente la sesión en la sección Remote.
  const deepLink = Linking.useURL();
  useEffect(() => {
    if (!deepLink) return;
    const match = deepLink.match(/remote\/([A-Za-z0-9_-]{20,})/);
    if (match) {
      setRemoteToken(match[1]);
      pushScreen('remote');
    }
  }, [deepLink, pushScreen]);

  // Tap sobre una notificación push de /remote → abre la sección Remote.
  useEffect(() => {
    const { onRemoteNotificationTap } = require('./src/push');
    return onRemoteNotificationTap(() => pushScreen('remote'));
  }, [pushScreen]);

  // Botón atrás de Android: cierra drawer o pantalla apilada antes de salir.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (drawerOpen) {
        closeDrawer();
        return true;
      }
      if (stack) {
        popScreen();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [drawerOpen, stack, closeDrawer, popScreen]);

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <ChatScreen onMenu={openDrawer} />

      {/* Pantalla apilada */}
      {stack != null && (
        <Animated.View
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            backgroundColor: c.bgSecondary,
            transform: [
              { translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [width, 0] }) },
            ],
          }}
        >
          {stack === 'usage' ? (
            <UsageScreen onBack={popScreen} />
          ) : stack === 'remote' ? (
            <RemoteScreen onBack={popScreen} initialToken={remoteToken} />
          ) : (
            <AccountScreen onBack={popScreen} />
          )}
        </Animated.View>
      )}

      {/* Drawer + scrim */}
      {drawerOpen && (
        <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}>
          <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, opacity: drawer }}>
            <Pressable onPress={closeDrawer} style={{ flex: 1, backgroundColor: c.scrim }} />
          </Animated.View>
          <Animated.View
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              width: drawerWidth,
              transform: [
                {
                  translateX: drawer.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-drawerWidth, 0],
                  }),
                },
              ],
            }}
          >
            <Sidebar open={drawerOpen} onClose={closeDrawer} onNavigate={pushScreen} />
          </Animated.View>
        </View>
      )}
    </View>
  );
}
