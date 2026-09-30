// prefijo.js — el identificador que se propone para un equipo nuevo. Es la
// misma regla que el gateway (team_issues.prefijo_de): «Lixbon Desktop» → «LD».
export function prefijoDe(nombre) {
  const palabras = String(nombre || '').normalize('NFD').replace(/\p{M}/gu, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  let pref = palabras.length >= 2 ? palabras.slice(0, 3).map((p) => p[0]).join('') : (palabras[0] || '').slice(0, 3);
  pref = pref.toUpperCase();
  return /^[A-Z][A-Z0-9]{0,4}$/.test(pref) ? pref : '';
}
