import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useT } from '../i18n/useT';

const ConfirmarContext = createContext(() => Promise.resolve(false));

export function ConfirmarProvider({ children }) {
  const tc = useT('common');
  const [pedido, setPedido] = useState(null);
  const resolver = useRef(null);

  const confirmar = useCallback((opciones) => new Promise((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve;
    setPedido(opciones);
  }), []);

  const terminar = (ok) => {
    resolver.current?.(ok);
    resolver.current = null;
    setPedido(null);
  };

  return (
    <ConfirmarContext.Provider value={confirmar}>
      {children}
      {pedido && (
        <ConfirmDialog
          title={pedido.titulo}
          confirmLabel={pedido.etiqueta || tc('confirm')}
          danger={pedido.peligro !== false}
          onConfirm={() => terminar(true)}
          onClose={() => terminar(false)}
        >
          {pedido.texto}
        </ConfirmDialog>
      )}
    </ConfirmarContext.Provider>
  );
}

export const useConfirmar = () => useContext(ConfirmarContext);
