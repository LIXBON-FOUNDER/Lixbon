// share.js — una conversación como Markdown para la hoja de compartir de
// Android (guardar en Drive, mandar por chat, copiar…).
import { Share } from 'react-native';

export function toMarkdown(title, messages) {
  const parts = [`# ${title || 'Conversación'}`, ''];
  for (const m of messages) {
    if (!m?.content) continue;
    parts.push(`## ${m.role === 'user' ? 'Tú' : 'lixbon'}`, '', String(m.content).trim(), '');
  }
  return parts.join('\n');
}

export function shareConversation(title, messages) {
  return Share.share({ title: title || 'Conversación', message: toMarkdown(title, messages) });
}

export async function shareConversationById(api, id) {
  const res = await api.get(`/api/conversations/${id}/messages`);
  const msgs = (Array.isArray(res?.messages) ? res.messages : []).filter((m) => m?.role === 'user' || m?.role === 'assistant');
  return shareConversation(res?.conversation?.title, msgs);
}
