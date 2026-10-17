import { useEffect, useState } from 'react';
import { api } from './api';

// Mientras el admin tenga las donaciones activas, la web las muestra donde iban
// las suscripciones (/plans y Ajustes › Facturación). Una sola petición por carga.
let pendiente = null;

export function leerDonaciones() {
  pendiente ??= api.get('/api/donations')
    .then((r) => r.data.donations)
    .catch(() => { pendiente = null; return { enabled: false, total_cents: 0 }; });
  return pendiente;
}

export function useDonaciones() {
  const [donaciones, setDonaciones] = useState(null);
  useEffect(() => {
    let vivo = true;
    leerDonaciones().then((d) => { if (vivo) setDonaciones(d); });
    return () => { vivo = false; };
  }, []);
  return donaciones;
}


export const MONTOS = [5, 10, 25, 50];

// La cuenta la sirve el gateway (PAYPAL_DONATION_BUSINESS). no_recurring=0 deja
// que el donante marque en PayPal que el aporte se repita cada mes.
export function urlPaypal(cuenta, monto) {
  if (!cuenta) return null;
  const params = new URLSearchParams({ business: cuenta, currency_code: 'USD', no_recurring: '0' });
  if (monto) params.set('amount', String(monto));
  return `https://www.paypal.com/donate/?${params}`;
}
