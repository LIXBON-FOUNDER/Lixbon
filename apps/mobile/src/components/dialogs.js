// dialogs.js — hojas inferiores, confirmaciones y avisos del sistema visual
// (Modal de RN sin animación propia: la subida y el velo los anima el sheet).
// API por promesas:
//   const { prompt, confirm, sheet, toast } = useDialogs();
//   sheet({ title, items: [{ label, description, icon, value, selected, danger, disabled, badge, divider }] })
//   sheet({ title, render: (close) => <…/> })   contenido propio
//   toast('Copiado') · toast('Conversación eliminada', { action: { label: 'Deshacer', onPress } })
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Animated, KeyboardAvoidingView, Modal, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FONTS, MOTION, RADIUS, RADIUS_SM } from '../theme';
import Icon from './Icon';
import { EASE, useColors, useReducedMotion } from './ui';

const DialogContext = createContext(null);
export const useDialogs = () => useContext(DialogContext);

/// Hoja inferior animada: el velo se funde y el panel sube 24px mientras
/// aparece. `onClosed` llega cuando terminó de salir.
export function BottomSheet({ visible, onDismiss, onClosed, children, keyboard = false, padding = 12 }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const { height } = useWindowDimensions();
  const anim = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      anim.setValue(0);
      Animated.timing(anim, { toValue: 1, duration: reduced ? 0 : MOTION.sheet, easing: EASE, useNativeDriver: true }).start();
    } else if (mounted) {
      Animated.timing(anim, { toValue: 0, duration: reduced ? 0 : 280, easing: EASE, useNativeDriver: true }).start(() => {
        setMounted(false);
        onClosed?.();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!mounted) return null;

  const panel = (
    <Animated.View
      style={{
        maxHeight: height * 0.86,
        backgroundColor: c.sheet,
        borderTopLeftRadius: RADIUS,
        borderTopRightRadius: RADIUS,
        paddingTop: 10,
        paddingHorizontal: padding,
        paddingBottom: 24 + insets.bottom,
        opacity: anim,
        transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
      }}
    >
      <View style={{ alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: c.surface6, marginBottom: 8 }} />
      {children}
    </Animated.View>
  );

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={onDismiss}>
      <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, opacity: anim }}>
        <Pressable accessibilityLabel="Cerrar" onPress={onDismiss} style={{ flex: 1, backgroundColor: c.scrim }} />
      </Animated.View>
      {keyboard ? (
        // 'padding' también en Android: con edge-to-edge la ventana ya no se
        // redimensiona sola y el campo quedaba debajo del teclado.
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: 'flex-end' }} pointerEvents="box-none">
          {panel}
        </KeyboardAvoidingView>
      ) : (
        <View style={{ flex: 1, justifyContent: 'flex-end' }} pointerEvents="box-none">
          {panel}
        </View>
      )}
    </Modal>
  );
}

export function SheetTitle({ children, detail }) {
  const c = useColors();
  return (
    <View style={{ marginTop: 8, marginBottom: 8, marginHorizontal: 8, gap: 6 }}>
      <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 19, letterSpacing: -0.2, color: c.ink }}>{children}</Text>
      {!!detail && <Text style={{ fontFamily: FONTS.ui, fontSize: 14.5, lineHeight: 21, color: c.ink70 }}>{detail}</Text>}
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
        gap: 14,
        minHeight: item.description ? 64 : 52,
        paddingHorizontal: item.description ? 12 : 14,
        paddingVertical: item.description ? 10 : 0,
        borderRadius: RADIUS,
        backgroundColor: item.selected ? c.surface4 : pressed ? c.pressed : 'transparent',
      })}
    >
      {!!item.icon && <Icon name={item.icon} size={19} color={item.danger ? c.danger : c.inkSoft} />}
      {!!item.swatch && <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: item.swatch }} />}
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          numberOfLines={1}
          style={{
            fontFamily: item.mono ? FONTS.mono : item.description ? FONTS.uiMedium : FONTS.ui,
            fontSize: item.mono ? 14 : 15,
            color,
          }}
        >
          {item.label}
        </Text>
        {!!item.description && <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>{item.description}</Text>}
      </View>
      {!!item.value2 && <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted }}>{item.value2}</Text>}
      {!!item.badge && (
        <View style={{ height: 24, justifyContent: 'center', paddingHorizontal: 8, borderRadius: RADIUS_SM, backgroundColor: c.surface4 }}>
          <Text style={{ fontFamily: FONTS.ui, fontSize: 12, color: c.ink70 }}>{item.badge}</Text>
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
        <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 15, color: c.onRaised }}>{cancelLabel}</Text>
      </Pressable>
      <Pressable
        onPress={onConfirm}
        style={({ pressed }) => [btn, { backgroundColor: danger ? c.dangerSoft : c.primary, transform: [{ scale: pressed ? 0.98 : 1 }] }]}
      >
        <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 15, color: danger ? c.danger : c.onPrimary }}>{confirmLabel || 'Aceptar'}</Text>
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
              fontSize: 16,
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

      <BottomSheet
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
              <Text style={{ fontFamily: FONTS.ui, fontSize: 14, color: c.inkMuted, margin: 12 }}>{sheetState?.emptyLabel || 'Sin opciones.'}</Text>
            )}
          </ScrollView>
        )}
      </BottomSheet>

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
            <Text style={{ flex: 1, paddingVertical: 12, fontFamily: FONTS.ui, fontSize: 14.5, color: c.onRaised }}>{toastState.message}</Text>
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
                <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 14.5, color: c.accent }}>{toastState.action.label}</Text>
              </Pressable>
            )}
          </View>
        </Animated.View>
      )}
    </DialogContext.Provider>
  );
}
