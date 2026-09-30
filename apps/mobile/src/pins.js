// pins.js — conversaciones fijadas arriba del historial. El servidor no guarda
// ese dato, así que vive en el dispositivo, por usuario.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

const listeners = new Set();
const cache = new Map();
const EMPTY = [];

const keyFor = (userId) => `pins:${userId}`;
const emit = () => listeners.forEach((f) => f());

async function load(userId) {
  if (!userId || cache.has(userId)) return;
  cache.set(userId, EMPTY);
  try {
    const ids = JSON.parse((await AsyncStorage.getItem(keyFor(userId))) || '[]');
    cache.set(userId, Array.isArray(ids) ? ids : EMPTY);
  } catch {
    // sin almacenamiento: nada fijado
  }
  emit();
}

export function togglePin(userId, convId) {
  if (!userId) return;
  const ids = cache.get(userId) || EMPTY;
  const next = ids.includes(convId) ? ids.filter((x) => x !== convId) : [convId, ...ids];
  cache.set(userId, next);
  AsyncStorage.setItem(keyFor(userId), JSON.stringify(next)).catch(() => {});
  emit();
}

function subscribe(f) {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function usePins(userId) {
  useEffect(() => {
    load(userId);
  }, [userId]);
  return useSyncExternalStore(subscribe, () => cache.get(userId) || EMPTY);
}

// Grupos del historial por última actividad, como en el IDE.
export function groupByDate(items, now = new Date()) {
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86400000;
  const groups = [
    ['Hoy', []],
    ['Ayer', []],
    ['Últimos 7 días', []],
    ['Últimos 30 días', []],
    ['Anteriores', []],
  ];
  for (const it of items) {
    const t = new Date(it.updated_at || it.created_at || 0).getTime() || 0;
    const i = t >= startToday ? 0 : t >= startToday - day ? 1 : t >= startToday - 7 * day ? 2 : t >= startToday - 30 * day ? 3 : 4;
    groups[i][1].push(it);
  }
  return groups.filter(([, list]) => list.length > 0);
}
