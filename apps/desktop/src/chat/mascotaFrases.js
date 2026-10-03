// mascotaFrases.js — lo que dicen Gael y Leya en el IDE. Varias frases por
// momento: se elige una al azar para que no repitan siempre lo mismo.

export const FRASES = {
  saludo: {
    manana: ['¡Buenos días! ¿Por dónde empezamos?', 'Buenos días. Café en mano y a programar.', '¡Hola! Hoy pinta productivo.'],
    tarde: ['¡Buenas tardes! ¿Qué construimos?', 'Buenas tardes. Listo para lo que pidas.', '¡Hola de nuevo! ¿Seguimos?'],
    noche: ['Buenas noches. ¿Trabajando hasta tarde?', 'Shh… el clúster también trasnocha.', '¡Hola, búho! ¿Qué preparamos?'],
  },
  listo: ['¡Listo!', '¡Hecho! Échale un vistazo.', 'Terminado. ¿Qué tal ha quedado?', '¡Ahí lo tienes!'],
  piensaMucho: ['Hmm… esto requiere pensarlo bien.', 'Dándole vueltas…', 'Un momento, que esta tiene miga.'],
  espera: ['Te necesito: revisa lo que te pide el agente.', '¡Eh! El agente quiere tu permiso.', 'Una cosita: falta tu respuesta arriba.'],
  despierta: ['¡Ah! Solo descansaba los ojos.', '¡Ya estoy! ¿Me perdí algo?', 'Uy, me quedé frito. Aquí sigo.'],
  toque: ['¡Hola!', 'Aquí sigo.', 'Pídeme algo y me pongo a ello.', '¡Eh, que hace cosquillas!', 'Puedes ocultarme en Ajustes › Mascota.'],
  suelta: [
    'Con @ puedes mencionar archivos en el chat.',
    'Escribe / para ver los comandos.',
    'Ctrl+N abre una conversación nueva.',
    'Puedes seguir al agente desde el móvil con el botón de arriba.',
    'En modo Plan el agente propone antes de tocar nada.',
    'Aquí sigo, por si me necesitas.',
  ],
};

export function saludoDeLaHora() {
  const h = new Date().getHours();
  return FRASES.saludo[h < 6 ? 'noche' : h < 13 ? 'manana' : h < 20 ? 'tarde' : 'noche'];
}
