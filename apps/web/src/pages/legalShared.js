// legalShared.js — datos del responsable y fecha de vigencia, iguales en los
// dos idiomas salvo el formato de la fecha; lo comparten legalContent.es.jsx
// y legalContent.en.jsx para no duplicarlos ni desincronizarlos.
export const RESPONSABLE = {
  nombre: '[Nombre o razón social del responsable]',
  nit: '[NIT o documento]',
  direccion: '[Dirección], Medellín, Colombia',
  correo: 'privacidad@lixbon.com',
  soporte: 'soporte@lixbon.com',
};

export const VIGENCIA = { es: '15 de septiembre de 2026', en: 'September 15, 2026' };
