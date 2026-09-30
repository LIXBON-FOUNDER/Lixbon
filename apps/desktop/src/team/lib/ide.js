// ide.js — el puente de Team con el IDE. En la app de escritorio la ventana de
// Team le habla a la del IDE con eventos de Tauri; en team.lixbon.com no hay IDE
// al lado, así que el texto se copia para pegarlo allí.

export const enTauri = () => typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

export const EVENTO_COMPONER = 'team:componer';

async function mandarAlIde(texto) {
  const { emitTo } = await import('@tauri-apps/api/event');
  await emitTo('main', EVENTO_COMPONER, { texto });
  const { getAllWindows } = await import('@tauri-apps/api/window');
  const ventanas = await getAllWindows();
  // Si Team se abrió con su acceso directo, el IDE está oculto: se muestra.
  const ide = ventanas.find((w) => w.label === 'main');
  await ide?.show();
  await ide?.unminimize();
  await ide?.setFocus();
}

function contexto(issue, t) {
  const partes = [`${issue.clave} · ${issue.titulo}`];
  if (issue.descripcion?.trim()) partes.push(issue.descripcion.trim());
  const subt = (issue.subtareas_lista || []).filter((x) => t.estadosPorId[x.estado_id]?.tipo !== 'hecho');
  if (subt.length) partes.push(`Subtareas pendientes:\n${subt.map((x) => `- ${x.clave} ${x.titulo}`).join('\n')}`);
  return partes.join('\n\n');
}

/** Prepara `/orquestar` con la issue en el chat del IDE. Devuelve '' o el error. */
export async function delegarAlOrquestador(issue, t) {
  const texto = `/orquestar Trabaja la issue ${contexto(issue, t)}\n\nUsa la rama lx/${issue.clave.toLowerCase()}-… y, al terminar, deja tu informe en la issue.`;
  try {
    if (enTauri()) await mandarAlIde(texto);
    else await navigator.clipboard.writeText(texto);
    return '';
  } catch (e) {
    return `No se pudo mandar al IDE: ${e?.message || e}`;
  }
}

/** Deja la issue citada en el chat del IDE para trabajarla a mano. */
export async function abrirEnElIde(issue) {
  const texto = `${issue.clave} · ${issue.titulo}`;
  try {
    if (enTauri()) await mandarAlIde(texto);
    else await navigator.clipboard.writeText(texto);
  } catch { /* sin IDE a mano: no pasa nada */ }
}
