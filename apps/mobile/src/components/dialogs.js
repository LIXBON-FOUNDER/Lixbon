// dialogs.js — diálogos, hoja inferior y toasts con la estética de la marca
// (Modal de RN, nada del look nativo). API por promesas:
//   const { prompt, confirm, sheet, toast } = useDialogs();
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FONTS, RADIUS_BOX, RADIUS_PILL } from '../theme';
import Icon from './Icon';
import { useColors } from './ui';

const DialogContext = createContext(null);
export const useDialogs = () => useContext(DialogContext);

export function DialogProvider({ children }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [dialog, setDialog] = useState(null); // {kind:'prompt'|'confirm', …}
  const [sheetState, setSheetState] = useState(null); // {title, items:[{label,icon,danger,value}]}
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
              backgroundColor: c.bg,
              borderRadius: RADIUS_BOX,
              borderWidth: 1,
              borderColor: c.borderSoft,
              padding: 20,
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
                placeholderTextColor={c.inkMuted}
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
                  backgroundColor: c.bgInput,
                  borderRadius: RADIUS_PILL,
                  paddingHorizontal: 20,
                  paddingVertical: 13,
                  fontFamily: FONTS.ui,
                  fontSize: 15,
                  color: c.ink,
                }}
              />
            )}
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 18, gap: 8 }}>
              <Pressable
                onPress={() => closeDialog(dialog?.kind === 'confirm' ? false : null)}
                style={{ paddingHorizontal: 16, paddingVertical: 11 }}
              >
                <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 14, color: c.inkSoft }}>
                  Cancelar
                </Text>
              </Pressable>
              <Pressable
                onPress={() => closeDialog(dialog?.kind === 'confirm' ? true : inputRef.current)}
                style={{
                  backgroundColor: dialog?.danger ? c.danger : c.primary,
                  borderRadius: RADIUS_PILL,
                  paddingHorizontal: 20,
                  paddingVertical: 11,
                }}
              >
                <Text
                  style={{
                    fontFamily: FONTS.uiMedium,
                    fontSize: 14,
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

      {/* Hoja inferior */}
      <Modal visible={!!sheetState} transparent animationType="slide" onRequestClose={() => closeSheet(null)}>
        <Pressable style={{ flex: 1, backgroundColor: c.scrim }} onPress={() => closeSheet(null)} />
        <View
          style={{
            backgroundColor: c.bg,
            borderTopLeftRadius: RADIUS_BOX,
            borderTopRightRadius: RADIUS_BOX,
            paddingTop: 10,
            paddingHorizontal: 12,
            paddingBottom: 14 + insets.bottom,
          }}
        >
          <View
            style={{
              alignSelf: 'center',
              width: 36,
              height: 4,
              borderRadius: 2,
              backgroundColor: c.borderSoft,
              marginBottom: 10,
            }}
          />
          {!!sheetState?.title && (
            <Text
              style={{
                fontFamily: FONTS.uiSemiBold,
                fontSize: 13,
                color: c.inkSoft,
                marginLeft: 10,
                marginBottom: 8,
              }}
            >
              {sheetState.title}
            </Text>
          )}
          {(sheetState?.items || []).map((item) => (
            <Pressable
              key={String(item.value)}
              onPress={() => closeSheet(item.value)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingHorizontal: 12,
                paddingVertical: 13,
                borderRadius: 14,
                backgroundColor: item.selected ? c.accentSoft : pressed ? c.bgSecondary : 'transparent',
              })}
            >
              {!!item.icon && (
                <Icon name={item.icon} size={19} color={item.danger ? c.danger : c.inkSoft} />
              )}
              <Text
                style={{
                  flex: 1,
                  fontFamily: item.selected ? FONTS.uiMedium : FONTS.ui,
                  fontSize: 15,
                  color: item.danger ? c.danger : c.ink,
                }}
              >
                {item.label}
              </Text>
              {item.selected && <Icon name="check" size={16} color={c.accentDeep} />}
            </Pressable>
          ))}
          {(sheetState?.items || []).length === 0 && (
            <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: c.inkMuted, margin: 10 }}>
              {sheetState?.emptyLabel || 'Sin opciones.'}
            </Text>
          )}
        </View>
      </Modal>

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
              borderRadius: RADIUS_PILL,
              paddingHorizontal: 18,
              paddingVertical: 11,
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
