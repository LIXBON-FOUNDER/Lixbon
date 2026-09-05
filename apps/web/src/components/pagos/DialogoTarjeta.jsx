// DialogoTarjeta.jsx — guardar una tarjeta sin cobrar nada (SetupIntent).
import { useEffect, useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { api } from '../../lib/api';
import { apariencia, cargarStripe } from '../../lib/stripe';
import { useCierreAnimado } from '../../hooks/useCierreAnimado';
import { LogoMark } from '../Logo';
import { IconShield, IconX } from '../Icons';
import { errMsg } from './comunes';

function Formulario({ onGuardada, onError }) {
  const stripe = useStripe();
  const elements = useElements();
  const [enviando, setEnviando] = useState(false);

  const enviar = async (ev) => {
    ev.preventDefault();
    if (!stripe || enviando) return;
    setEnviando(true);
    onError('');
    const { error, setupIntent } = await stripe.confirmSetup({
      elements,
      redirect: 'if_required',
    });
    if (error) {
      onError(error.message || 'No se pudo guardar la tarjeta.');
      setEnviando(false);
      return;
    }
    onGuardada(setupIntent.payment_method);
  };

  return (
    <form className="pago__form" onSubmit={enviar}>
      <div className="pago__elements"><PaymentElement options={{ layout: 'tabs' }} /></div>
      <button className="pago__cta" type="submit" disabled={!stripe || enviando}>
        {enviando ? 'Guardando…' : 'Guardar tarjeta'}
      </button>
    </form>
  );
}

export function DialogoTarjeta({ onGuardada, onCerrar }) {
  const [stripe, setStripe] = useState(null);
  const [secreto, setSecreto] = useState(null);
  const [error, setError] = useState('');
  const { cerrando, cerrar } = useCierreAnimado(onCerrar);

  useEffect(() => { cargarStripe().then(setStripe); }, []);

  useEffect(() => {
    api.post('/api/billing/setup-intent')
      .then((res) => setSecreto(res.data.client_secret))
      .catch((e) => setError(errMsg(e, 'No se pudo preparar el formulario de tarjeta.')));
  }, []);

  const guardada = async (pmId) => {
    await onGuardada(pmId);
    cerrar();
  };

  return (
    <div className={cerrando ? 'pago-overlay is-closing' : 'pago-overlay'} onClick={cerrar}>
      <div className="pago" onClick={(e) => e.stopPropagation()}>
        <span className="pago__tab" aria-hidden="true" />
        <div className="pago__caja">
          <div className="pago__head">
            <div className="pago__marca">
              <LogoMark size={24} />
              <span className="pago__nombre">Añadir tarjeta</span>
            </div>
            <button className="icon-btn" onClick={cerrar} aria-label="Cerrar"><IconX /></button>
          </div>

          {error && <p className="pago__error" role="alert">{error}</p>}

          {secreto ? (
            <Elements stripe={stripe} options={{ clientSecret: secreto, appearance: apariencia() }}>
              <Formulario onGuardada={guardada} onError={setError} />
            </Elements>
          ) : (
            !error && <p className="pago__cargando">Preparando el formulario seguro…</p>
          )}

          <p className="pago__pie">
            <IconShield size={13} />
            <span>
              No se cobra nada ahora. El número de tu tarjeta lo guarda Stripe, no lixbon.
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}
