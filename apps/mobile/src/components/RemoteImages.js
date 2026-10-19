// RemoteImages.js — las imágenes del chat remoto: las que manda la persona y
// las que el agente le enseña con show_image. El host las sube al gateway con
// el id que ya viaja en el evento, así que una recién llegada puede tardar un
// momento: la miniatura reintenta mientras tanto. Tocarla abre el visor a
// pantalla completa (pellizcar acerca, deslizar hacia abajo cierra) con
// Guardar y Compartir.
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Image, Modal, PanResponder, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import Icon from './Icon';
import { useColors } from './ui';
import { FONTS, RADIUS, RADIUS_SM } from '../theme';

/** { source(id), open(image) }: lo da la pantalla remota a todo el hilo. */
export const RemoteImageContext = createContext(null);

const RETRIES = 6;

/** Una imagen del chat: por id (en el gateway) o por uri (aún en el móvil). */
export function RemoteImage({ image, style, resizeMode = 'cover' }) {
  const c = useColors();
  const ctx = useContext(RemoteImageContext);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const source = image.uri ? { uri: image.uri } : ctx?.source(image.id, attempt);
  if (!source || failed) {
    return (
      <View style={[style, { alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface4 }]}>
        <Icon name="image" size={18} color={c.inkMuted} />
      </View>
    );
  }
  return (
    <Image
      source={source}
      resizeMode={resizeMode}
      accessibilityIgnoresInvertColors
      style={[{ backgroundColor: c.surface4 }, style]}
      onError={() => {
        if (image.uri || attempt >= RETRIES) {
          setFailed(true);
          return;
        }
        timer.current = setTimeout(() => setAttempt((a) => a + 1), 1200 * (attempt + 1));
      }}
    />
  );
}

/** Miniatura que abre el visor al tocarla. */
export function ImageThumb({ image, width, height, radius = RADIUS_SM, label }) {
  const ctx = useContext(RemoteImageContext);
  return (
    <Pressable
      onPress={() => ctx?.open(image)}
      accessibilityRole="imagebutton"
      accessibilityLabel={label || image.name || 'Imagen'}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <RemoteImage image={image} style={{ width, height, borderRadius: radius }} />
    </Pressable>
  );
}

/** La imagen que el agente enseñó: ancha, con su nombre o pie debajo. */
export function ShownImageCard({ item, maxWidth }) {
  const c = useColors();
  const ratio = item.w > 0 && item.h > 0 ? item.h / item.w : 10 / 16;
  const height = Math.min(maxWidth * ratio, 420);
  return (
    <View style={{ gap: 6, marginVertical: 8 }}>
      <ImageThumb image={item} width={maxWidth} height={height} radius={RADIUS} label={item.caption || item.name} />
      <Text style={{ fontFamily: FONTS.ui, fontSize: 12.5, lineHeight: 17, color: c.inkMuted }}>
        {item.caption ? `${item.caption} · ${item.name}` : `${item.name} · toca para ampliar`}
      </Text>
    </View>
  );
}

/** Estado del visor para la pantalla: la imagen abierta y cómo abrirla. */
export function useImageViewer() {
  const [image, setImage] = useState(null);
  return { image, open: setImage, close: () => setImage(null) };
}

const distance = (touches) => {
  const [a, b] = touches;
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
};

/** Visor a pantalla completa con pellizco, arrastre y deslizar para cerrar. */
export function ImageViewer({ image, onClose, download }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const scale = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const g = useRef({ scale: 1, current: 1, x: 0, y: 0, pinch: 0, base: 1, lastTap: 0 }).current;
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    g.scale = 1;
    g.x = 0;
    g.y = 0;
    scale.setValue(1);
    tx.setValue(0);
    ty.setValue(0);
    setNote('');
  }, [image, g, scale, tx, ty]);

  const reset = () => {
    g.scale = 1;
    g.x = 0;
    g.y = 0;
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: false }),
      Animated.spring(tx, { toValue: 0, useNativeDriver: false }),
      Animated.spring(ty, { toValue: 0, useNativeDriver: false }),
    ]).start();
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          const now = Date.now();
          if (now - g.lastTap < 280) {
            // Doble toque: acerca o vuelve al tamaño normal.
            if (g.scale > 1) reset();
            else {
              g.scale = 2.5;
              Animated.spring(scale, { toValue: 2.5, useNativeDriver: false }).start();
            }
          }
          g.lastTap = now;
          g.pinch = 0;
        },
        onPanResponderMove: (e, gesture) => {
          const touches = e.nativeEvent.touches;
          if (touches.length >= 2) {
            const d = distance(touches);
            if (!g.pinch) {
              g.pinch = d;
              g.base = g.scale;
            }
            g.current = Math.max(1, Math.min(5, (g.base * d) / g.pinch));
            scale.setValue(g.current);
            return;
          }
          if (g.scale > 1) {
            tx.setValue(g.x + gesture.dx);
            ty.setValue(g.y + gesture.dy);
          } else if (gesture.dy > 0) {
            ty.setValue(gesture.dy);
          }
        },
        onPanResponderRelease: (e, gesture) => {
          if (g.pinch) {
            g.scale = g.current || g.scale;
            if (g.scale <= 1.02) reset();
            g.pinch = 0;
            return;
          }
          if (g.scale > 1) {
            g.x += gesture.dx;
            g.y += gesture.dy;
            return;
          }
          if (gesture.dy > 120) onClose();
          else Animated.spring(ty, { toValue: 0, useNativeDriver: false }).start();
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onClose],
  );

  if (!image) return null;

  const fileFor = async () => {
    if (image.uri) return new File(image.uri);
    const dir = new Directory(Paths.cache, 'remote-images');
    if (!dir.exists) dir.create();
    const target = new File(dir, image.id);
    if (target.exists) return target;
    const { url, headers } = download(image.id);
    return File.downloadFileAsync(url, target, { headers, idempotent: true });
  };

  const save = async () => {
    setBusy('save');
    try {
      const perm = await MediaLibrary.requestPermissionsAsync(true, ['photo']);
      if (!perm.granted) {
        setNote('Sin permiso para guardar en la galería');
        return;
      }
      const file = await fileFor();
      await MediaLibrary.saveToLibraryAsync(file.uri);
      setNote('Guardada en la galería');
    } catch {
      setNote('No se pudo guardar la imagen');
    } finally {
      setBusy('');
    }
  };

  const share = async () => {
    setBusy('share');
    try {
      const file = await fileFor();
      await Sharing.shareAsync(file.uri, { dialogTitle: image.name || 'Imagen' });
    } catch {
      setNote('No se pudo compartir la imagen');
    } finally {
      setBusy('');
    }
  };

  const ratio = image.w > 0 && image.h > 0 ? image.h / image.w : 10 / 16;
  const imgW = width;
  const imgH = Math.min(imgW * ratio, height * 0.72);

  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: '#050505' }}>
        <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Cerrar" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="x" size={20} color="#F2F2F0" />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 14, color: '#F2F2F0' }}>{image.name || 'Imagen'}</Text>
            <Text numberOfLines={1} style={{ fontFamily: FONTS.ui, fontSize: 12, color: '#8A8A86' }}>
              {[image.shown ? 'El agente te la enseñó' : 'La enviaste tú', image.w > 0 ? `${image.w}×${image.h}` : ''].filter(Boolean).join(' · ')}
            </Text>
          </View>
        </View>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }} {...responder.panHandlers}>
          <Animated.View style={{ transform: [{ translateX: tx }, { translateY: ty }, { scale }] }}>
            <RemoteImage image={image} resizeMode="contain" style={{ width: imgW, height: imgH, backgroundColor: 'transparent' }} />
          </Animated.View>
        </View>
        {!!note && <Text style={{ textAlign: 'center', fontFamily: FONTS.ui, fontSize: 13, color: '#D6D6D3', paddingBottom: 8 }}>{note}</Text>}
        <View style={{ paddingHorizontal: 16, paddingBottom: Math.max(insets.bottom, 12) + 6, gap: 10 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <ViewerButton label={busy === 'save' ? 'Guardando…' : 'Guardar'} onPress={save} disabled={!!busy} />
            <ViewerButton label={busy === 'share' ? 'Preparando…' : 'Compartir'} onPress={share} disabled={!!busy} />
          </View>
          <Text style={{ textAlign: 'center', fontFamily: FONTS.ui, fontSize: 12, color: '#5E5E5C' }}>
            pellizca para acercar · desliza hacia abajo para cerrar
          </Text>
        </View>
      </View>
    </Modal>
  );
}

function ViewerButton({ label, onPress, disabled }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => ({ flex: 1, height: 44, borderRadius: RADIUS_SM, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? '#333330' : '#262626', opacity: disabled ? 0.6 : 1 })}
    >
      <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 14, color: '#F2F2F0' }}>{label}</Text>
    </Pressable>
  );
}
