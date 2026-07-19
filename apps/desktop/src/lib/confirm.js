// confirm.js — diálogo de confirmación propio con hasta 3 opciones y campo de
// texto opcional. El `ask` de Tauri solo admite 2 botones, y flujos como
// "Guardar y cerrar / Cerrar sin guardar / Cancelar" o "renombrar símbolo"
// necesitan más. La UI vive en components/ConfirmDialog.jsx (montada en
// AppShell); aquí solo el estado y la promesa.

import { create } from 'zustand';

export const useConfirmStore = create(() => ({
  dialog: null, // { title, message, options: [{id,label,kind}], input, resolve }
}));

/**
 * Muestra el diálogo y resuelve con { choice, value }:
 * - choice: id de la opción pulsada ('cancel' si Escape / clic fuera)
 * - value: texto del input (solo si se pidió `input: { value, placeholder }`)
 */
export function showConfirm({ title = 'lixbon', message, options, input = null }) {
  return new Promise((resolve) => {
    // Si hubiera uno abierto (no debería), se cancela para no colgar su promesa.
    const prev = useConfirmStore.getState().dialog;
    if (prev) prev.resolve({ choice: 'cancel', value: null });
    useConfirmStore.setState({ dialog: { title, message, options, input, resolve } });
  });
}

/** La llama ConfirmDialog al pulsar una opción (o cancelar). */
export function resolveConfirm(choice, value = null) {
  const { dialog } = useConfirmStore.getState();
  if (!dialog) return;
  useConfirmStore.setState({ dialog: null });
  dialog.resolve({ choice, value });
}
