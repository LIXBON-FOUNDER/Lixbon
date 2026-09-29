// dialogs.js — diálogos, hoja inferior y toasts con el sistema del IDE
// (Modal de RN, nada del look nativo). API por promesas:
//   const { prompt, confirm, sheet, toast } = useDialogs();
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FONTS, RADIUS, RADIUS_BOX } from '../theme';
import Icon from './Icon';
import { EASE, Eyebrow, useColors, useReducedMotion } from './ui';

const DialogContext = createContext(null);
export const useDialogs = () => useContext(DialogContext);

export function DialogProvider({ children }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [dialog, setDialog] = useState(null); // {kind:'prompt'|'confirm', …}
  // {title, subtitle, items:[{label, description, hint, icon, group, danger, selected, value}]}
  const [sheetState, setSheetState] = useState(null);
  const [toastMsg, setToastMsg] = useState(null);
  const toastAnim = useRef(new Animated.Value(0)).current;
  const toastTimer = useRef(null);
  const inputRef = useRef('');

  /// Diálogo con input (renombrar, contraseña, servidor…). Resuelve con el
  /// texto introducido, o null si se canceló.
  const prompt = useCallback(
    (opts) =>
      new Promise((resolve) => {
        inputRef.current = opts.initialValue || '';
        setDialog({ kind: 'prompt', ...opts, resolve });
      }),
    [],
  );

  /// Confirmación simple. Resuelve true si el usuario acepta.
  const confirm = useCallback(
    (opts) =>
      new Promise((resolve) => {
        setDialog({ kind: 'confirm', ...opts, resolve });
      }),
    [],
  );

  /// Hoja inferior de acciones/opciones. Resuelve con item.value o null.
  const sheet = useCallback(
    (opts) =>
      new Promise((resolve) => {
        setSheetState({ ...opts, resolve });
      }),
    [],
  );

  const toast = useCallback(
    (message) => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      setToastMsg(message);
      Animated.timing(toastAnim, { toValue: 1, duration: 160, useNativeDriver: true }).start();
      toastTimer.current = setTimeout(() => {
        Animated.timing(toastAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(
          () => setToastMsg(null),
        );
      }, 2600);
    },
    [toastAnim],
  );

  const closeDialog = (result) => {
    dialog?.resolve(result);
    setDialog(null);
  };
  const closeSheet = (result) => {
    sheetState?.resolve(result);
    setSheetState(null);
  };

  const api = { prompt, confirm, sheet, toast };

  return (
    <DialogContext.Provider value={api}>
      {children}

      {/* Prompt / Confirm */}
      <Modal visible={!!dialog} transparent animationType="fade" onRequestClose={() => closeDialog(dialog?.kind === 'confirm' ? false : null)}>
        {/* 'padding' también en Android: con edge-to-edge la ventana ya no se
            redimensiona sola, así que dejarlo en undefined dejaba el campo de
            texto del diálogo debajo del teclado. */}
        <KeyboardAvoidingView
          behavior="padding"
          style={{ flex: 1, backgroundColor: c.scrim, justifyContent: 'center', padding: 26 }}
        >
          <View
            style={{
              backgroundColor: c.surface2,
              borderRadius: RADIUS_BOX,
              padding: 18,
            }}
          >
            <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 17, color: c.ink }}>
              {dialog?.title}
            </Text>
            {!!dialog?.message && (
              <Text style={{ fontFamily: FONTS.ui, fontSize: 14, color: c.inkSoft, marginTop: 8, lineHeight: 20 }}>
                {dialog.message}
              </Text>
            )}
            {dialog?.kind === 'prompt' && (
              <TextInput
                defaultValue={dialog.initialValue || ''}
                placeholder={dialog.placeholder || ''}
                placeholderTextColor={c.inkLabel}
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
                  marginTop: 14,
                  backgroundColor: c.surface3,
                  borderRadius: RADIUS,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  fontFamily: FONTS.ui,
                  fontSize: 15,
                  color: c.ink,
                }}
              />
            )}
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 18, gap: 8 }}>
              <Pressable
                onPress={() => closeDialog(dialog?.kind === 'confirm' ? false : null)}
                style={({ pressed }) => ({ paddingHorizontal: 14, height: 38, justifyContent: 'center', borderRadius: RADIUS, backgroundColor: pressed ? c.pressed : c.surface5 })}
              >
                <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 13.5, color: c.inkBody }}>
                  Cancelar
                </Text>
              </Pressable>
              <Pressable
                onPress={() => closeDialog(dialog?.kind === 'confirm' ? true : inputRef.current)}
                style={({ pressed }) => ({
                  backgroundColor: dialog?.danger ? c.dangerStrong : c.primary,
                  borderRadius: RADIUS,
                  paddingHorizontal: 16,
                  height: 38,
                  justifyContent: 'center',
                  transform: [{ scale: pressed ? 0.96 : 1 }],
                })}
              >
                <Text
                  style={{
                    fontFamily: FONTS.uiSemiBold,
                    fontSize: 13.5,
                    color: dialog?.danger ? '#FFFFFF' : c.onPrimary,
                  }}
                >
                  {dialog?.confirmLabel || 'Aceptar'}
                </Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <ActionSheet state={sheetState} onClose={closeSheet} />

      {/* Toast */}
      {toastMsg != null && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 24,
            right: 24,
            bottom: 90 + insets.bottom,
            alignItems: 'center',
            opacity: toastAnim,
            transform: [
              { translateY: toastAnim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
            ],
          }}
        >
          <View
            style={{
              backgroundColor: c.primary,
              borderRadius: RADIUS,
              paddingHorizontal: 16,
              paddingVertical: 10,
            }}
          >
            <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 13, color: c.onPrimary }}>
              {toastMsg}
            </Text>
          </View>
        </Animated.View>
      )}
    </DialogContext.Provider>
  );
}

// Tarjeta flotante como la paleta, no la hoja nativa pegada al borde. El Modal
// sigue montado mientras sale para poder animar el cierre.
function ActionSheet({ state, onClose }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const anim = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState(null);

  useEffect(() => {
    if (state) {
      setShown(state);
      anim.setValue(0);
      Animated.timing(anim, { toValue: 1, duration: reduced ? 0 : 220, easing: EASE, useNativeDriver: true }).start();
    } else if (shown) {
      Animated.timing(anim, { toValue: 0, duration: reduced ? 0 : 160, easing: EASE, useNativeDriver: true }).start(() => setShown(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const items = shown?.items || [];
  const pick = (value) => state && onClose(value);

  return (
    <Modal visible={!!shown} transparent animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={() => pick(null)}>
      <Animated.View style={{ flex: 1, justifyContent: 'flex-end', opacity: anim }}>
        <Pressable onPress={() => pick(null)} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: c.scrim }} />
        <Animated.View
          style={{
            marginHorizontal: 8,
            marginBottom: insets.bottom + 8,
            maxHeight: '78%',
            borderRadius: RADIUS_BOX,
            backgroundColor: c.surface2,
            overflow: 'hidden',
            transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) }],
          }}
        >
          {!!shown?.title && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, minHeight: 50, paddingVertical: 10, backgroundColor: c.surface3 }}>
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={{ fontFamily: FONTS.uiSemiBold, fontSize: 14.5, color: c.ink }}>{shown.title}</Text>
                {!!shown.subtitle && (
                  <Text numberOfLines={1} style={{ fontFamily: FONTS.mono, fontSize: 10.5, color: c.inkLabel, marginTop: 2 }}>{shown.subtitle}</Text>
                )}
              </View>
              <Pressable onPress={() => pick(null)} hitSlop={8}>
                <Text style={{ fontFamily: FONTS.mono, fontSize: 11, color: c.inkLabel }}>Esc</Text>
              </Pressable>
            </View>
          )}
          <ScrollView contentContainerStyle={{ padding: 6 }} bounces={false}>
            {items.map((item, i) => {
              const prev = items[i - 1];
              const newGroup = item.group && item.group !== prev?.group;
              const dangerStart = item.danger && prev && !prev.danger;
              return (
                <View key={String(item.value)}>
                  {newGroup && <Eyebrow style={{ paddingHorizontal: 10, paddingTop: i ? 12 : 6, paddingBottom: 5 }}>{item.group}</Eyebrow>}
                  {dangerStart && !newGroup && <View style={{ height: 1, marginHorizontal: 10, marginVertical: 5, backgroundColor: c.surface4 }} />}
                  <Pressable
                    onPress={() => pick(item.value)}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                      minHeight: item.description ? 54 : 44,
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      borderRadius: RADIUS,
                      backgroundColor: pressed ? c.surface4 : item.selected ? c.accentSoft : 'transparent',
                    })}
                  >
                    {!!item.icon && (
                      <View
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: RADIUS,
                          alignItems: 'center',
                          justifyContent: 'center',
                          backgroundColor: item.danger ? c.dangerSoft : c.surface3,
                        }}
                      >
                        <Icon name={item.icon} size={16} color={item.danger ? c.danger : item.selected ? c.accentDeep : c.inkSoft} />
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text
                        numberOfLines={1}
                        style={{
                          fontFamily: item.mono ? FONTS.mono : item.selected ? FONTS.uiMedium : FONTS.ui,
                          fontSize: item.mono ? 13 : 14,
                          color: item.danger ? c.danger : item.selected ? c.ink : c.inkBody,
                        }}
                      >
                        {item.label}
                      </Text>
                      {!!item.description && (
                        <Text numberOfLines={2} style={{ fontFamily: FONTS.ui, fontSize: 12, lineHeight: 16, color: c.inkLabel, marginTop: 2 }}>
                          {item.description}
                        </Text>
                      )}
                    </View>
                    {!!item.hint && (
                      <Text style={{ fontFamily: FONTS.mono, fontSize: 9.5, color: c.inkLabel, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, backgroundColor: c.pressed }}>
                        {String(item.hint).toUpperCase()}
                      </Text>
                    )}
                    {item.selected && <Icon name="check" size={16} color={c.accentDeep} />}
                  </Pressable>
                </View>
              );
            })}
            {items.length === 0 && (
              <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted, margin: 10 }}>{shown?.emptyLabel || 'Sin opciones.'}</Text>
            )}
          </ScrollView>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}
