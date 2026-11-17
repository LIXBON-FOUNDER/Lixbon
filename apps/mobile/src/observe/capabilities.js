const ACTIONS = { resume: 'Reanudar sesión', interrupt: 'Interrumpir', steer: 'Orientar durante la ejecución', answer: 'Responder al proveedor' };
const STATES = {
  available: { label: 'Disponible', tone: 'ok' },
  unsupported: { label: 'No soportado', tone: 'muted' },
  unavailable: { label: 'No disponible ahora', tone: 'warn' },
  environment_blocked: { label: 'Bloqueado por el entorno', tone: 'warn' },
  unknown: { label: 'Sin información', tone: 'muted' },
};
const BLOCKS = {
  cli_missing: 'Instala el proveedor en el escritorio.',
  cli_flags_unsupported: 'Actualiza el proveedor en el escritorio.',
  windows_sandbox_elevated: 'Revisa el sandbox en el escritorio.',
  windows_sandbox_setup: 'Completa la configuración del sandbox en el escritorio.',
};

export function capabilitySummary(data) {
  return Object.entries(ACTIONS).map(([key, label]) => {
    const capability = data?.capabilities?.[key];
    let state = STATES[capability?.state] || STATES.unknown;
    const blocked = data?.profile_block;
    const available = capability?.state === 'available';
    let detail = BLOCKS[capability?.block] || null;
    if (available && blocked) {
      state = STATES.environment_blocked;
      detail = BLOCKS[blocked] || 'El entorno impide usar el perfil de este intento.';
    }
    if (key === 'resume' && available && !blocked) {
      if (!data?.session) {
        state = STATES.unavailable;
        detail = 'El intento no tiene una sesión nativa registrada.';
      } else if (data.session.status === 'closed' || data.session.resumable !== true || data.session.bound !== true) {
        state = STATES.unavailable;
        detail = 'La sesión de este intento no está disponible para reanudar.';
      } else {
        detail = 'Sesión nativa disponible. La ejecución queda sujeta a la policy del Core.';
      }
    }
    return { key, label, stateLabel: state.label, tone: state.tone, detail };
  });
}
