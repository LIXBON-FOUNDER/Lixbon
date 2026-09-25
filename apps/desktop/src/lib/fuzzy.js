// fuzzy.js — coincidencia por subsecuencia con bonus por caracteres seguidos.
export function fuzzyScore(text, q) {
  const t = text.toLowerCase();
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return -1;
    streak = idx === ti ? streak + 3 : 1;
    score += streak - Math.min(idx - ti, 20) * 0.05;
    ti = idx + 1;
  }
  return score - t.length * 0.01;
}
