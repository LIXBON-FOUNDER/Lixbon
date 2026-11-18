export const CONTEXT_NOTES = {
  truncated: 'El paquete contiene campos recortados.',
  redacted: 'Se ocultaron valores al crear el paquete.',
  revision_absent: 'Falta la revisión de código.',
  attachment_omitted: 'Se omitieron adjuntos al crear el paquete.',
  attachment_not_scanned: 'Hay adjuntos que no se pudieron escanear.',
};

export function portabilityText(summary) {
  if (!summary || summary.status === 'absent') return 'Todavía no hay un ContextPackage guardado. Puedes prepararlo desde el escritorio.';
  if (summary.status !== 'valid') return 'El Core rechazó el paquete. Hay que revisarlo en el escritorio antes de continuar o transferir trabajo.';
  return {
    ready: 'Paquete válido y completo para preparar una transferencia. El Core comprobará el destino al usarlo.',
    partial: 'El paquete es parcial. Revisa lo que falta en el escritorio antes de transferirlo.',
    attachments_missing: 'Faltan adjuntos guardados. Compruébalos en el escritorio antes de transferirlo.',
    attachments_not_verified: 'La identidad del paquete está verificada. Los bytes de los adjuntos deben comprobarse al recibirlos.',
  }[summary.portability] || 'El Core no confirmó la transferibilidad del paquete.';
}

export function contextSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Sin dato';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
