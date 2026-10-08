// Los campos de tarjeta son iframes de Stripe: el número no pasa por nuestro
// servidor (alcance PCI mínimo). La entrada principal de @stripe/stripe-js
// inyecta el script al importarse; /pure espera a que se llame a loadStripe.
import { loadStripe } from '@stripe/stripe-js/pure';
import { api } from './api';

let promesa = null;

export function cargarStripe() {
  if (!promesa) {
    promesa = api.get('/api/billing/config')
      .then((res) => (res.data.publishable_key
        ? loadStripe(res.data.publishable_key)
        : null))
      .catch(() => null);
  }
  return promesa;
}

const leer = (nombre, respaldo) => {
  if (typeof window === 'undefined') return respaldo;
  const v = getComputedStyle(document.documentElement).getPropertyValue(nombre);
  return v.trim() || respaldo;
};

export function apariencia() {
  return {
    theme: 'night',
    variables: {
      colorPrimary: leer('--accent', '#B4C64E'),
      colorBackground: leer('--field', '#1C1C1C'),
      colorText: leer('--ink', '#F2F2F0'),
      colorTextSecondary: leer('--ink-muted', '#7C7C79'),
      colorTextPlaceholder: leer('--ink-faint', '#5E5E5C'),
      colorDanger: leer('--danger-ink', '#D4785F'),
      fontFamily: leer('--font-ui', 'Geist, sans-serif'),
      fontSizeBase: '14px',
      spacingUnit: '4px',
      borderRadius: '8px',
    },
    rules: {
      '.Input': {
        border: 'none',
        boxShadow: 'none',
        padding: '13px 15px',
      },
      '.Input:focus': {
        border: 'none',
        boxShadow: 'none',
        backgroundColor: leer('--field-focus', '#242424'),
      },
      '.Input--invalid': {
        boxShadow: 'none',
        backgroundColor: leer('--field-error', '#241715'),
      },
      '.Label': {
        fontSize: '12px',
        fontWeight: '500',
        color: leer('--ink-soft', '#B0B0AD'),
      },
      '.Tab, .Block': { border: 'none', boxShadow: 'none' },
    },
  };
}
