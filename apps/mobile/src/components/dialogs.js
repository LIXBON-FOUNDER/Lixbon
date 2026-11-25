import { Pressable } from './MotionPressable';
import Reanimated, { Easing as NativeEasing, useAnimatedStyle, useSharedValue, withTiming, runOnJS, cancelAnimation } from 'react-native-reanimated';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { CURVES } from '../theme';
import { dismissSheet, sheetDrag } from './motion';
import { LINEAS } from '../theme';
import { TEXT } from '../theme';
import { Text, TextInput } from './Typography';
// dialogs.js — hojas inferiores, confirmaciones y avisos del sistema visual
// (Modal de RN sin animación propia: la subida y el velo los anima el sheet).
// API por promesas:
//   const { prompt, confirm, sheet, toast } = useDialogs();
//   sheet({ title, items: [{ label, description, icon, value, selected, danger, disabled, badge, divider }] })
//   sheet({ title, render: (close) => <…/> })   contenido propio
//   toast('Copiado') · toast('Conversación eliminada', { action: { label: 'Deshacer', onPress } })
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Animated, KeyboardAvoidingView, Modal,  ScrollView,   View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FONTS, MOTION, RADIUS, RADIUS_SM } from '../theme';
import Icon from './Icon';
import { EASE, useColors, useReducedMotion } from './ui';

const DialogContext = createContext(null);
export const useDialogs = () => useContext(DialogContext);

export function BottomSheet({ visible, onDismiss, onClosed, children, keyboard = false, padding = LINEAS.menuCaja }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const { height } = useWindowDimensions();
  const progress = useSharedValue(0);
  const drag = useSharedValue(0);
  const panelHeight = useSharedValue(height * 0.86);
  const [mounted, setMounted] = useState(visible);
  const callbacks = useRef({ onClosed, onDismiss, visible });
  callbacks.current = { onClosed, onDismiss, visible };
  const close = () => { if (callbacks.current.visible) return; setMounted(false); callbacks.current.onClosed?.(); };
  const dismiss = () => callbacks.current.onDismiss?.();
  useEffect(() => {
    if (visible) {
      setMounted(true);
      drag.value = 0;
      progress.value = withTiming(1, { duration: reduced ? 120 : MOTION.sheet, easing: NativeEasing.bezier(...CURVES.sheet) });
    } else if (mounted) {
      progress.value = withTiming(0, { duration: reduced ? 120 : MOTION.sheetClose, easing: NativeEasing.bezier(...CURVES.sheet) }, (finished) => { if (finished) runOnJS(close)(); });
    }
    return () => cancelAnimation(progress);
  }, [visible, reduced]);
  const panelStyle = useAnimatedStyle(() => ({ opacity: progress.value, transform: reduced ? [] : [{ translateY: (1 - progress.value) * panelHeight.value + drag.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const gesture = Gesture.Pan().minDistance(4).onUpdate((event) => {
    if (!reduced) drag.value = sheetDrag(event.translationY);
  }).onEnd((event) => {
    if (dismissSheet(event.translationY, event.velocityY / 1000)) runOnJS(dismiss)();
    else drag.value = withTiming(0, { duration: MOTION.sheetClose, easing: NativeEasing.bezier(...CURVES.sheet) });
  }).onFinalize((event, succeeded) => { if (!succeeded) drag.value = withTiming(0, { duration: MOTION.sheetClose }); });
  if (!mounted) return null;
  const panel = <Reanimated.View onLayout={(event) => { panelHeight.value = event.nativeEvent.layout.height; }} style={[{
    maxHeight: height * 0.86, backgroundColor: c.sheet, borderTopLeftRadius: RADIUS, borderTopRightRadius: RADIUS,
    paddingHorizontal: padding, paddingBottom: 24 + insets.bottom,
  }, panelStyle]}>
    <GestureDetector gesture={gesture}><View accessible accessibilityRole="button" accessibilityLabel="Cerrar hoja" accessibilityActions={[{ name: 'activate', label: 'Cerrar hoja' }]} onAccessibilityAction={() => onDismiss?.()} onAccessibilityTap={onDismiss} style={{ height: LINEAS.tacto, alignItems: 'center', justifyContent: 'center' }}><View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: c.surface6 }} /></View></GestureDetector>
    {children}
  </Reanimated.View>;
  return <Modal visible transparent animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={onDismiss}>
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Reanimated.View style={[{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }, scrimStyle]}><Pressable accessibilityLabel="Cerrar" onPress={onDismiss} style={{ flex: 1, backgroundColor: c.scrim }} /></Reanimated.View>
      {keyboard ? <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: 'flex-end' }} pointerEvents="box-none">{panel}</KeyboardAvoidingView> : <View style={{ flex: 1, justifyContent: 'flex-end' }} pointerEvents="box-none">{panel}</View>}
    </GestureHandlerRootView>
  </Modal>;
}

export function AnchoredMenu({ visible, anchor, onDismiss, onClosed, children, padding = LINEAS.menuCaja }) {
  const c = useColors();
  const reduced = useReducedMotion();
  const { width, height } = useWindowDimensions();
  const [mounted, setMounted] = useState(visible);
  const progress = useSharedValue(0);
  const callbacks = useRef({ onClosed, visible }); callbacks.current = { onClosed, visible };
  const close = () => { if (callbacks.current.visible) return; setMounted(false); callbacks.current.onClosed?.(); };
  useEffect(() => {
    if (visible) { setMounted(true); progress.value = withTiming(1, { duration: MOTION.menu, easing: NativeEasing.bezier(...CURVES.out) }); }
    else if (mounted) progress.value = withTiming(0, { duration: MOTION.menuClose, easing: NativeEasing.bezier(...CURVES.out) }, (finished) => { if (finished) runOnJS(close)(); });
    return () => cancelAnimation(progress);
  }, [visible, reduced]);
  const animated = useAnimatedStyle(() => ({ opacity: progress.value, transform: reduced ? [] : [{ scale: 0.96 + progress.value * 0.04 }] }));
  if (!mounted) return null;
  const menuWidth = Math.min(340, width - 2 * LINEAS.caja);
  const left = Math.max(LINEAS.caja, Math.min(anchor.x, width - menuWidth - LINEAS.caja));
  const bottom = Math.max(LINEAS.caja, height - anchor.y + LINEAS.caja);
  return <Modal visible transparent animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={onDismiss}>
    <Pressable accessibilityLabel="Cerrar menú" onPress={onDismiss} style={{ flex: 1 }} />
    <Reanimated.View style={[{ position: 'absolute', left, bottom, width: menuWidth, maxHeight: Math.max(100, anchor.y - 2 * LINEAS.caja), padding, backgroundColor: c.sheet, borderRadius: RADIUS, transformOrigin: [Math.max(0, Math.min(menuWidth, anchor.x + anchor.width / 2 - left)), '100%', 0] }, animated]}>{children}</Reanimated.View>
  </Modal>;
}

export function SheetTitle({ children, detail }) {
  const c = useColors();
  return (
    <View style={{ marginTop: 8, marginBottom: 8, marginHorizontal: 8, gap: 6 }}>
      <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: TEXT.title, letterSpacing: -0.2, color: c.ink }}>{children}</Text>
      {!!detail && <Text style={{ fontFamily: FONTS.ui, fontSize: TEXT.secondary, lineHeight: 21, color: c.ink70 }}>{detail}</Text>}
    </View>
  );
}

/// Fila de una hoja: icono opcional, texto con descripción y marca de elegido.
export function SheetItem({ item, onPress }) {
  const c = useColors();
  if (item.divider) return <View style={{ height: 1, marginVertical: 6, marginHorizontal: 14, backgroundColor: c.borderSoft }} />;
  const color = item.danger ? c.danger : item.disabled ? c.ink70 : c.ink;
  return (
    <Pressable
      onPress={onPress}
      disabled={item.disabled}
      accessibilityRole={item.selected != null ? 'radio' : 'button'}
      accessibilityState={{ selected: !!item.selected, disabled: !!item.disabled }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: LINEAS.menuTexto - LINEAS.menuIcono - LINEAS.icono,
        minHeight: item.description ? 64 : 52,
        paddingHorizontal: LINEAS.menuIcono - LINEAS.menuCaja,
        paddingVertical: item.description ? 10 : 0,
        borderRadius: RADIUS,
        backgroundColor: item.selected ? c.surface4 : pressed ? c.pressed : 'transparent',
      })}
    >
      {!!item.icon && <Icon name={item.icon} size={LINEAS.icono} color={item.danger ? c.danger : c.inkSoft} />}
      {!!item.swatch && <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: item.swatch }} />}
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          numberOfLines={1}
          style={{
            fontFamily: item.mono ? FONTS.mono : item.description ? FONTS.uiMedium : FONTS.ui,
            fontSize: item.mono ? 14 : 16,
            color,
          }}
        >
          {item.label}
        </Text>
        {!!item.description && <Text style={{ fontFamily: FONTS.ui, fontSize: TEXT.meta, color: c.inkMuted }}>{item.description}</Text>}
      </View>
      {!!item.value2 && <Text style={{ fontFamily: FONTS.ui, fontSize: TEXT.meta, color: c.inkMuted }}>{item.value2}</Text>}
      {!!item.badge && (
        <View style={{ height: 24, justifyContent: 'center', paddingHorizontal: 8, borderRadius: RADIUS_SM, backgroundColor: c.surface4 }}>
          <Text style={{ fontFamily: FONTS.ui, fontSize: TEXT.meta, color: c.ink70 }}>{item.badge}</Text>
        </View>
      )}
      {item.selected && <Icon name="check" size={18} color={c.accent} strokeWidth={2} />}
    </Pressable>
  );
}

function SheetButtons({ cancelLabel = 'Cancelar', confirmLabel, danger, onCancel, onConfirm }) {
  const c = useColors();
  const btn = { flex: 1, height: 50, borderRadius: RADIUS, alignItems: 'center', justifyContent: 'center' };
  return (
    <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, marginHorizontal: 8 }}>
      <Pressable onPress={onCancel} style={({ pressed }) => [btn, { backgroundColor: c.raised, opacity: pressed ? 0.85 : 1 }]}>
        <Text style={{ fontFamily: FONTS.uiMedium, fontSize: TEXT.body, color: c.onRaised }}>{cancelLabel}</Text>
      </Pressable>
      <Pressable
        onPress={onConfirm}
        style={({ pressed }) => [btn, { backgroundColor: danger ? c.dangerAction : c.primary, transform: [{ scale: pressed ? 0.98 : 1 }] }]}
      >
        <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: TEXT.body, color: danger ? c.onDanger : c.onPrimary }}>{confirmLabel || 'Aceptar'}</Text>
      </Pressable>
    </View>
  );
}

export function DialogProvider({ children }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [dialog, setDialog] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sheetState, setSheetState] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [toastState, setToastState] = useState(null);
  const toastAnim = useRef(new Animated.Value(0)).current;
  const toastTimer = useRef(null);
  const pendingRef = useRef(null);
  const inputRef = useRef('');
  const resultRef = useRef(null);

  /// Hoja con un campo (renombrar, contraseña, servidor…). Resuelve con el
  /// texto, o null si se canceló.
  const prompt = useCallback(
    (opts) =>
      new Promise((resolve) => {
        inputRef.current = opts.initialValue || '';
        setDialog({ kind: 'prompt', ...opts, resolve });
        setDialogOpen(true);
      }),
    [],
  );

  /// Confirmación en hoja inferior. Resuelve true si el usuario acepta.
  const confirm = useCallback(
    (opts) =>
      new Promise((resolve) => {
        setDialog({ kind: 'confirm', ...opts, resolve });
        setDialogOpen(true);
      }),
    [],
  );

  /// Hoja de opciones. Resuelve con item.value (o lo que pase `close`) o null.
  const sheet = useCallback(
    (opts) =>
      new Promise((resolve) => {
        resultRef.current = null;
        setSheetState({ ...opts, resolve });
        setSheetOpen(true);
      }),
    [],
  );

  const hideToast = useCallback(() => {
    clearTimeout(toastTimer.current);
    Animated.timing(toastAnim, { toValue: 0, duration: reduced ? 0 : 280, easing: EASE, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setToastState(null);
    });
  }, [toastAnim, reduced]);

  // Un aviso con "Deshacer" aplaza la acción hasta que se va (onTimeout); si
  // otro aviso lo reemplaza antes, la acción se confirma en ese momento.
  const toast = useCallback(
    (message, opts = {}) => {
      clearTimeout(toastTimer.current);
      pendingRef.current?.();
      pendingRef.current = opts.onTimeout || null;
      setToastState({ message, ...opts, key: Date.now() });
      toastAnim.setValue(0);
      Animated.timing(toastAnim, { toValue: 1, duration: reduced ? 0 : MOTION.fade, easing: EASE, useNativeDriver: true }).start();
      toastTimer.current = setTimeout(() => {
        pendingRef.current?.();
        pendingRef.current = null;
        hideToast();
      }, opts.duration || (opts.action ? 5000 : 2600));
    },
    [toastAnim, reduced, hideToast],
  );

  // La promesa se resuelve al terminar de salir, para que lo siguiente (otra
  // hoja, un diálogo) no se monte encima de la que se está yendo.
  const closeDialog = (result) => {
    resultRef.current = result;
    setDialogOpen(false);
  };
  const closeSheet = (result) => {
    resultRef.current = result;
    setSheetOpen(false);
  };

  const api = { prompt, confirm, sheet, toast };
  const SheetFrame = sheetState?.anchor ? AnchoredMenu : BottomSheet;

  return (
    <DialogContext.Provider value={api}>
      {children}

      <BottomSheet
        visible={dialogOpen}
        keyboard={dialog?.kind === 'prompt'}
        padding={12}
        onDismiss={() => closeDialog(dialog?.kind === 'confirm' ? false : null)}
        onClosed={() => {
          dialog?.resolve(resultRef.current ?? (dialog?.kind === 'confirm' ? false : null));
          setDialog(null);
        }}
      >
        <SheetTitle detail={dialog?.message}>{dialog?.title}</SheetTitle>
        {dialog?.kind === 'prompt' && (
          <TextInput
            defaultValue={dialog.initialValue || ''}
            placeholder={dialog.placeholder || ''}
            placeholderTextColor={c.inkMuted}
            selectionColor={c.accent}
            secureTextEntry={!!dialog.secure}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(v) => {
              inputRef.current = v;
            }}
            onSubmitEditing={() => closeDialog(inputRef.current)}
            style={{
              marginTop: 4,
              marginHorizontal: 8,
              height: 48,
              backgroundColor: c.surface4,
              borderRadius: RADIUS,
              paddingHorizontal: 14,
              fontFamily: FONTS.uiMedium,
              fontSize: TEXT.body,
              color: c.ink,
            }}
          />
        )}
        <SheetButtons
          confirmLabel={dialog?.confirmLabel}
          danger={dialog?.danger}
          onCancel={() => closeDialog(dialog?.kind === 'confirm' ? false : null)}
          onConfirm={() => closeDialog(dialog?.kind === 'confirm' ? true : inputRef.current)}
        />
      </BottomSheet>

      <SheetFrame anchor={sheetState?.anchor}
        visible={sheetOpen}
        keyboard={!!sheetState?.keyboard}
        onDismiss={() => closeSheet(null)}
        onClosed={() => {
          sheetState?.resolve(resultRef.current);
          setSheetState(null);
        }}
      >
        {!!sheetState?.title && <SheetTitle detail={sheetState.detail}>{sheetState.title}</SheetTitle>}
        {sheetState?.render ? (
          sheetState.render(closeSheet)
        ) : (
          <ScrollView bounces={false} contentContainerStyle={{ gap: 2 }}>
            {(sheetState?.items || []).map((item, i) => (
              <SheetItem key={item.divider ? `d${i}` : String(item.value)} item={item} onPress={() => closeSheet(item.value)} />
            ))}
            {(sheetState?.items || []).length === 0 && (
              <Text style={{ fontFamily: FONTS.ui, fontSize: TEXT.secondary, color: c.inkMuted, margin: 12 }}>{sheetState?.emptyLabel || 'Sin opciones.'}</Text>
            )}
          </ScrollView>
        )}
      </SheetFrame>

      {toastState != null && (
        <Animated.View
          key={toastState.key}
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            left: 12,
            right: 12,
            bottom: 96 + insets.bottom,
            opacity: toastAnim,
            transform: [{ translateY: toastAnim.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
          }}
        >
          <View
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            style={{
              minHeight: 50,
              paddingLeft: 16,
              paddingRight: toastState.action ? 6 : 16,
              borderRadius: RADIUS,
              backgroundColor: c.raised,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
            }}
          >
            {!!toastState.icon && <Icon name={toastState.icon} size={17} color={c.accent} strokeWidth={2} />}
            <Text style={{ flex: 1, paddingVertical: 12, fontFamily: FONTS.ui, fontSize: TEXT.secondary, color: c.onRaised }}>{toastState.message}</Text>
            {!!toastState.action && (
              <Pressable
                onPress={() => {
                  pendingRef.current = null;
                  toastState.action.onPress();
                  hideToast();
                }}
                style={({ pressed }) => ({
                  height: 38,
                  paddingHorizontal: 12,
                  borderRadius: RADIUS_SM,
                  justifyContent: 'center',
                  backgroundColor: pressed ? 'rgba(255,255,255,0.06)' : 'transparent',
                })}
              >
                <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: TEXT.secondary, color: c.accent }}>{toastState.action.label}</Text>
              </Pressable>
            )}
          </View>
        </Animated.View>
      )}
    </DialogContext.Provider>
  );
}
