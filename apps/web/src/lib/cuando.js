// «dentro de 3 horas», «mañana»…: cuándo se reinicia un cupo.
export function cuando(resetAt, idioma) {
  if (!resetAt) return '';
  const min = Math.max(1, Math.round((new Date(resetAt) - Date.now()) / 60000));
  const rtf = new Intl.RelativeTimeFormat(idioma, { numeric: 'auto' });
  if (min < 60) return rtf.format(min, 'minute');
  if (min < 48 * 60) return rtf.format(Math.round(min / 60), 'hour');
  return rtf.format(Math.round(min / 1440), 'day');
}
