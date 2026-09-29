// attachments.js — mismo modelo que la web (apps/web/src/lib/adjuntos.js):
// los documentos van a /api/attachments, que devuelve su texto; las imágenes se
// encogen aquí y /api/vision/describe las describe, así funcionan con cualquier
// modelo. Todo llega al modelo como texto antepuesto al mensaje.
import * as DocumentPicker from 'expo-document-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

const MAX_SIDE = 1400;
const QUALITY = 0.85;
const MAX_DOC_BYTES = 5 * 1024 * 1024;

const DOC_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/*',
  'application/json',
  'application/xml',
  'application/octet-stream',
];

export async function pickDocuments() {
  const res = await DocumentPicker.getDocumentAsync({ type: DOC_TYPES, multiple: true, copyToCacheDirectory: true });
  if (res.canceled) return [];
  return res.assets.map((a) => ({
    kind: a.mimeType?.startsWith('image/') ? 'image' : 'doc',
    uri: a.uri,
    name: a.name || 'documento',
    mimeType: a.mimeType || 'application/octet-stream',
    size: a.size,
  }));
}

export async function pickImages({ camera = false } = {}) {
  if (camera) {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error('Sin permiso para usar la cámara.');
  }
  const opts = { mediaTypes: ['images'], quality: 1, allowsMultipleSelection: !camera, selectionLimit: 4 };
  const res = camera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  if (res.canceled) return [];
  return res.assets.map((a, i) => ({
    kind: 'image',
    uri: a.uri,
    name: a.fileName || `imagen-${i + 1}.jpg`,
    mimeType: a.mimeType || 'image/jpeg',
  }));
}

async function shrinkImage(uri) {
  let ref = await ImageManipulator.manipulate(uri).renderAsync();
  if (Math.max(ref.width, ref.height) > MAX_SIDE) {
    const size = ref.width >= ref.height ? { width: MAX_SIDE } : { height: MAX_SIDE };
    ref = await ImageManipulator.manipulate(ref).resize(size).renderAsync();
  }
  const out = await ref.saveAsync({ compress: QUALITY, format: SaveFormat.JPEG, base64: true });
  return { uri: out.uri, base64: out.base64 };
}

// describeImages=false: la imagen va tal cual (control remoto: el agente del
// host la ve directamente, Claude Code incluido).
export async function readAttachment(api, file, { describeImages = true } = {}) {
  if (file.kind === 'image') {
    const { uri, base64 } = await shrinkImage(file.uri);
    if (!describeImages) return { preview: uri, base64, mime: 'image/jpeg' };
    const res = await api.post('/api/vision/describe', { images: [base64] });
    const text = (res?.description || '').trim();
    if (!text) throw new Error('El modelo de visión no devolvió nada.');
    return { preview: uri, text };
  }
  if (file.size && file.size > MAX_DOC_BYTES) throw new Error('supera el límite de 5 MB.');
  const form = new FormData();
  form.append('file', { uri: file.uri, name: file.name, type: file.mimeType });
  const res = await api.upload('/api/attachments', form);
  return { text: res.text, truncated: !!res.truncated };
}

const HEADER = /^--- (Documento adjunto|Imagen adjunta): (.+?)(?: \(descrita por un modelo de visión\))? ---$/gm;
const SEPARATOR = '\n\n---\n\n';

export function composeMessage(text, attachments) {
  if (attachments.length === 0) return text;
  const context = attachments
    .map((a) =>
      a.kind === 'image'
        ? `--- Imagen adjunta: ${a.name} (descrita por un modelo de visión) ---\n${a.text}`
        : `--- Documento adjunto: ${a.name} ---\n${a.text}`,
    )
    .join('\n\n');
  const question =
    text || (attachments.some((a) => a.kind === 'image') ? 'Analiza esta imagen.' : 'Analiza este documento.');
  return `${context}${SEPARATOR}${question}`;
}

// Separa el contexto de los adjuntos de la pregunta para no pintar el texto
// extraído entero en la burbuja (también en conversaciones que vienen de la web).
export function splitMessage(content) {
  if (!content || !content.startsWith('--- ')) return { files: [], text: content };
  const cut = content.lastIndexOf(SEPARATOR);
  if (cut < 0) return { files: [], text: content };
  const files = [...content.slice(0, cut).matchAll(HEADER)].map((m) => ({
    kind: m[1] === 'Imagen adjunta' ? 'image' : 'doc',
    name: m[2],
  }));
  if (files.length === 0) return { files: [], text: content };
  return { files, text: content.slice(cut + SEPARATOR.length) };
}
