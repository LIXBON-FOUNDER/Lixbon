// Camera.js — cámara propia para adjuntar al chat (en vez de saltar a la app
// de cámara del sistema): modo Foto o Documento con guía de esquinas, flash y
// cambio de cámara; después una revisión donde se repite, se gira, se añaden
// páginas y se escribe qué hacer con ellas. Devuelve las imágenes y el texto
// al compositor, que es donde se envían.
import { CameraView, useCameraPermissions } from 'expo-camera';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Image, Linking, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { pickImages } from '../attachments';
import { FONTS, MOTION, RADIUS, RADIUS_SM } from '../theme';
import Icon from './Icon';
import { Breathe, EASE, KeyboardAware, useColors, useReducedMotion } from './ui';

const FLASH = ['off', 'auto', 'on'];
const FLASH_LABEL = { off: 'Flash apagado', auto: 'Flash automático', on: 'Flash encendido' };
// La guía del modo Documento ocupa este marco del visor (proporción A4).
const GUIDE = { widthRatio: 0.74, aspect: 1.32 };

const glass = { width: 44, height: 44, borderRadius: RADIUS, backgroundColor: 'rgba(0,0,0,0.42)', alignItems: 'center', justifyContent: 'center' };

export default function CameraModal({ visible, onClose, onDone }) {
  const [pages, setPages] = useState([]);
  const [stage, setStage] = useState('camera'); // camera | review
  const [docMode, setDocMode] = useState(true);

  useEffect(() => {
    if (visible) {
      setPages([]);
      setStage('camera');
    }
  }, [visible]);

  const addPages = (list) => {
    setPages((cur) => [...cur, ...list]);
    setStage('review');
  };

  return (
    <Modal visible={visible} animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={stage === 'review' ? () => setStage('camera') : onClose}>
      <View style={{ flex: 1, backgroundColor: '#000000' }}>
        {stage === 'camera' ? (
          <CameraStage docMode={docMode} onMode={setDocMode} onClose={pages.length ? () => setStage('review') : onClose} onCapture={addPages} />
        ) : (
          <ReviewStage
            pages={pages}
            docMode={docMode}
            onRetake={() => {
              setPages((cur) => cur.slice(0, -1));
              setStage('camera');
            }}
            onAddPage={() => setStage('camera')}
            onRotate={(i, page) => setPages((cur) => cur.map((p, k) => (k === i ? page : p)))}
            onSend={(text) =>
              onDone(
                pages.map((p, i) => ({ kind: 'image', uri: p.uri, name: `${docMode ? 'pagina' : 'foto'}-${i + 1}.jpg`, mimeType: 'image/jpeg' })),
                text,
              )
            }
          />
        )}
      </View>
    </Modal>
  );
}

function CameraStage({ docMode, onMode, onClose, onCapture }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const camRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [facing, setFacing] = useState('back');
  const [flash, setFlash] = useState('auto');
  const [frame, setFrame] = useState(null);

  if (!permission) return <View style={{ flex: 1 }} />;
  if (!permission.granted) {
    return (
      <View style={{ flex: 1, paddingTop: insets.top + 14, paddingHorizontal: 24, paddingBottom: insets.bottom + 28 }}>
        <Pressable onPress={onClose} accessibilityLabel="Cerrar cámara" style={[glass, { marginLeft: -14, backgroundColor: 'transparent' }]}>
          <Icon name="x" size={20} color="#F2F2F0" />
        </Pressable>
        <View style={{ flex: 1, justifyContent: 'center', gap: 12 }}>
          <Text style={{ fontFamily: FONTS.serif, fontSize: 30, lineHeight: 35, color: '#F2F2F0' }}>Lixbon necesita la cámara</Text>
          <Text style={{ fontFamily: FONTS.ui, fontSize: 15, lineHeight: 22, color: '#B0B0AD' }}>Para fotografiar documentos y adjuntarlos al chat. Las fotos solo salen del teléfono cuando las envías.</Text>
        </View>
        <Pressable
          onPress={permission.canAskAgain ? requestPermission : () => Linking.openSettings()}
          style={({ pressed }) => ({ height: 50, borderRadius: RADIUS, backgroundColor: '#F2F2F0', alignItems: 'center', justifyContent: 'center', transform: [{ scale: pressed ? 0.98 : 1 }] })}
        >
          <Text style={{ fontFamily: FONTS.uiSemiBold, fontSize: 15, color: '#0E0E0E' }}>{permission.canAskAgain ? 'Permitir la cámara' : 'Abrir los ajustes'}</Text>
        </Pressable>
      </View>
    );
  }

  const guide = frame && {
    width: frame.width * GUIDE.widthRatio,
    height: Math.min(frame.width * GUIDE.widthRatio * GUIDE.aspect, frame.height * 0.78),
  };
  if (guide) {
    guide.left = (frame.width - guide.width) / 2;
    guide.top = (frame.height - guide.height) / 2 - 10;
  }

  const capture = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const photo = await camRef.current.takePictureAsync({ quality: 0.9 });
      let uri = photo.uri;
      if (docMode && guide) {
        // El visor recorta la foto como "cover": se deshace esa escala para
        // llevar el marco de la guía a píxeles de la foto.
        const scale = Math.max(frame.width / photo.width, frame.height / photo.height);
        const ox = (photo.width * scale - frame.width) / 2;
        const oy = (photo.height * scale - frame.height) / 2;
        const rect = {
          originX: Math.max(0, Math.round((guide.left + ox) / scale)),
          originY: Math.max(0, Math.round((guide.top + oy) / scale)),
          width: Math.round(guide.width / scale),
          height: Math.round(guide.height / scale),
        };
        rect.width = Math.min(rect.width, photo.width - rect.originX);
        rect.height = Math.min(rect.height, photo.height - rect.originY);
        const ref = await ImageManipulator.manipulate(uri).crop(rect).renderAsync();
        uri = (await ref.saveAsync({ compress: 0.9, format: SaveFormat.JPEG })).uri;
      }
      onCapture([{ uri, cropped: docMode }]);
    } catch {
      setBusy(false);
    }
  };

  const fromGallery = async () => {
    try {
      const files = await pickImages();
      if (files.length) onCapture(files.map((f) => ({ uri: f.uri, cropped: false })));
    } catch {
      // selector cancelado o sin permiso: se queda en la cámara
    }
  };

  return (
    <>
      <View style={{ flex: 1, borderBottomLeftRadius: RADIUS, borderBottomRightRadius: RADIUS, overflow: 'hidden', backgroundColor: '#1A1915' }} onLayout={(e) => setFrame(e.nativeEvent.layout)}>
        <CameraView ref={camRef} style={{ flex: 1 }} facing={facing} flash={flash} onCameraReady={() => setReady(true)} animateShutter />
        {docMode && guide && <Guide rect={guide} color={c.accent} />}
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, paddingTop: insets.top + 14, paddingHorizontal: 10, flexDirection: 'row', justifyContent: 'space-between' }}>
          <Pressable onPress={onClose} accessibilityLabel="Cerrar cámara" style={glass}>
            <Icon name="x" size={20} color="#F2F2F0" />
          </Pressable>
          <Pressable onPress={() => setFlash(FLASH[(FLASH.indexOf(flash) + 1) % FLASH.length])} accessibilityLabel={FLASH_LABEL[flash]} style={glass}>
            <Icon name={flash === 'off' ? 'flash-off' : 'flash'} size={19} color={flash === 'on' ? c.accent : '#F2F2F0'} />
            {flash === 'auto' && <Text style={{ position: 'absolute', right: 7, bottom: 5, fontFamily: FONTS.uiSemiBold, fontSize: 9, color: '#F2F2F0' }}>A</Text>}
          </Pressable>
        </View>
        {docMode && (
          <View style={{ position: 'absolute', bottom: 18, left: 0, right: 0, alignItems: 'center' }}>
            <View style={{ height: 32, paddingHorizontal: 12, borderRadius: RADIUS_SM, backgroundColor: 'rgba(0,0,0,0.55)', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.accent }} />
              <Text style={{ fontFamily: FONTS.ui, fontSize: 13, color: '#F2F2F0' }}>Encuadra el documento en las esquinas</Text>
            </View>
          </View>
        )}
      </View>

      <View style={{ paddingTop: 18, paddingHorizontal: 28, paddingBottom: insets.bottom + 26, gap: 20 }}>
        <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', justifyContent: 'center', gap: 28 }}>
          {[
            [false, 'Foto'],
            [true, 'Documento'],
          ].map(([value, label]) => (
            <Pressable key={label} onPress={() => onMode(value)} accessibilityRole="radio" accessibilityState={{ selected: docMode === value }} style={{ height: 32, justifyContent: 'center' }}>
              <Text style={{ fontFamily: FONTS.uiMedium, fontSize: 13.5, color: docMode === value ? c.accent : '#8A8A86' }}>{label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Pressable onPress={fromGallery} accessibilityLabel="Elegir de la galería" style={{ width: 48, height: 48, borderRadius: RADIUS, backgroundColor: '#2A2925', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="image" size={20} color="#D6D6D3" />
          </Pressable>
          <Pressable
            onPress={capture}
            disabled={!ready || busy}
            accessibilityLabel="Capturar"
            style={{ width: 76, height: 76, borderRadius: 38, borderWidth: 3, borderColor: '#F2F2F0', alignItems: 'center', justifyContent: 'center', opacity: ready ? 1 : 0.5 }}
          >
            {({ pressed }) => <View style={{ width: pressed || busy ? 54 : 60, height: pressed || busy ? 54 : 60, borderRadius: 30, backgroundColor: '#F2F2F0' }} />}
          </Pressable>
          <Pressable
            onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))}
            accessibilityLabel="Cambiar de cámara"
            style={{ width: 48, height: 48, borderRadius: RADIUS, backgroundColor: '#1C1C1C', alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="camera-switch" size={21} color="#D6D6D3" />
          </Pressable>
        </View>
      </View>
    </>
  );
}

function Guide({ rect, color }) {
  const corner = { position: 'absolute', width: 28, height: 28, borderColor: color };
  const w = 3;
  return (
    <Breathe from={0.55} to={1} style={{ position: 'absolute', left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
      <View style={[corner, { left: 0, top: 0, borderLeftWidth: w, borderTopWidth: w, borderTopLeftRadius: RADIUS_SM }]} />
      <View style={[corner, { right: 0, top: 0, borderRightWidth: w, borderTopWidth: w, borderTopRightRadius: RADIUS_SM }]} />
      <View style={[corner, { left: 0, bottom: 0, borderLeftWidth: w, borderBottomWidth: w, borderBottomLeftRadius: RADIUS_SM }]} />
      <View style={[corner, { right: 0, bottom: 0, borderRightWidth: w, borderBottomWidth: w, borderBottomRightRadius: RADIUS_SM }]} />
    </Breathe>
  );
}

function ReviewStage({ pages, docMode, onRetake, onAddPage, onRotate, onSend }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [text, setText] = useState('');
  const [rotating, setRotating] = useState(false);
  const index = pages.length - 1;
  const page = pages[index];
  const settle = useRef(new Animated.Value(reduced ? 1 : 0)).current;

  useEffect(() => {
    settle.setValue(reduced ? 1 : 0);
    Animated.timing(settle, { toValue: 1, duration: reduced ? 0 : MOTION.sheet, easing: EASE, useNativeDriver: true }).start();
  }, [page?.uri, settle, reduced]);

  const rotate = async () => {
    if (!page || rotating) return;
    setRotating(true);
    try {
      const ref = await ImageManipulator.manipulate(page.uri).rotate(90).renderAsync();
      const out = await ref.saveAsync({ compress: 0.92, format: SaveFormat.JPEG });
      onRotate(index, { ...page, uri: out.uri });
    } finally {
      setRotating(false);
    }
  };

  if (!page) return null;
  const count = pages.length === 1 ? '1 página' : `${pages.length} páginas`;

  return (
    <KeyboardAware>
      <View style={{ paddingTop: insets.top + 10, paddingHorizontal: 10, height: insets.top + 64, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Pressable onPress={onRetake} style={({ pressed }) => ({ height: 44, paddingHorizontal: 12, borderRadius: RADIUS, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: pressed ? 'rgba(255,255,255,0.06)' : 'transparent' })}>
          <Icon name="refresh" size={17} color="#D6D6D3" />
          <Text style={{ fontFamily: FONTS.ui, fontSize: 14.5, color: '#D6D6D3' }}>Repetir</Text>
        </Pressable>
        <Pressable onPress={rotate} accessibilityLabel="Girar" style={({ pressed }) => ({ width: 44, height: 44, borderRadius: RADIUS, alignItems: 'center', justifyContent: 'center', opacity: rotating ? 0.5 : 1, backgroundColor: pressed ? 'rgba(255,255,255,0.06)' : 'transparent' })}>
          <Icon name="rotate" size={19} color="#D6D6D3" />
        </Pressable>
      </View>

      <View style={{ flex: 1, paddingHorizontal: 32, paddingVertical: 12 }}>
        <Animated.View
          style={{
            flex: 1,
            opacity: settle.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }),
            transform: [{ scale: settle.interpolate({ inputRange: [0, 1], outputRange: [1.04, 1] }) }, { rotate: settle.interpolate({ inputRange: [0, 1], outputRange: ['-3deg', '0deg'] }) }],
          }}
        >
          <Image source={{ uri: page.uri }} resizeMode="contain" accessibilityLabel={docMode ? 'Documento capturado' : 'Foto capturada'} style={{ flex: 1, borderRadius: 4 }} />
        </Animated.View>
      </View>

      <Text style={{ marginBottom: 14, textAlign: 'center', fontFamily: FONTS.ui, fontSize: 13, color: '#8A8A86' }}>
        {page.cropped ? `${count} · recortada a la guía` : count}
      </Text>

      <View style={{ marginHorizontal: 12, marginBottom: insets.bottom + 18, padding: 6, borderRadius: RADIUS, backgroundColor: c.dark ? c.surface2 : '#181818', flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Pressable onPress={onAddPage} accessibilityLabel="Añadir otra página" style={{ width: 44, height: 44, borderRadius: RADIUS_SM, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="plus" size={20} color="#B0B0AD" />
        </Pressable>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="¿Qué hago con esto?"
          placeholderTextColor="#8A8A86"
          selectionColor={c.accent}
          accessibilityLabel="Indicación"
          style={{ flex: 1, height: 44, paddingVertical: 0, fontFamily: FONTS.ui, fontSize: 15, color: '#F2F2F0' }}
        />
        <Pressable
          onPress={() => onSend(text.trim())}
          accessibilityLabel="Llevar al chat"
          style={({ pressed }) => ({ width: 44, height: 44, borderRadius: RADIUS_SM, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', transform: [{ scale: pressed ? 0.94 : 1 }] })}
        >
          <Icon name="arrow-up" size={18} color={c.onAccent} strokeWidth={1.8} />
        </Pressable>
      </View>
    </KeyboardAware>
  );
}
