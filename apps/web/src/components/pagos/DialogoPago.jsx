// DialogoPago.jsx — el modal de cobro, con sus tres desenlaces.
//
// El cobro no sale de lixbon. La tarjeta nueva se guarda contra Stripe con un
// SetupIntent y de ahí solo sale un `pm_...`; el cargo se pide al backend con
// ese id. Si el banco pide confirmación, Stripe abre su propio marco encima:
// esa pantalla es del emisor y no se puede vestir, así que aquí solo se pinta
// la espera alrededor.
import { useCallback, useEffect, useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { api } from '../../lib/api';
import { apariencia, cargarStripe } from '../../lib/stripe';
import { useCierreAnimado } from '../../hooks/useCierreAnimado';
import { LogoMark } from '../Logo';
import { IconAlert, IconCheck, IconDownload, IconPlus, IconShield, IconX } from '../Icons';
import { Tarjeta, errMsg, fmtUSD } from './comunes';

function Cuerpo({
  resumen, extra, etiquetaAccion, guardarFijo, notaGuardar,
  metodos, elegido, setElegido, secreto, pedirTarjetaNueva,
  guardar, setGuardar, cobrar, onResultado, error, setError,
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [enviando, setEnviando] = useState(false);
  const nueva = elegido === 'nueva';

  const enviar = async (ev) => {
    ev.preventDefault();
    if (!stripe || enviando) return;
    setError('');
    setEnviando(true);
    try {
      let pm = elegido;
      if (nueva) {
        const { error: fallo, setupIntent } = await stripe.confirmSetup({
          elements,
          redirect: 'if_required',
        });
        if (fallo) {
          setError(fallo.message || 'No se pudo guardar la tarjeta.');
          setEnviando(false);
          return;
        }
        pm = setupIntent.payment_method;
      }
      const res = await cobrar(pm, guardarFijo || guardar);
      await onResultado(res, stripe);
    } catch (e) {
      const d = e?.response?.data?.detail;
      // Solo el 402 viene del emisor. Un 400 de validación o un 502 de la
      // pasarela pintados como rechazo mandan a cambiar una tarjeta que va bien.
      const delBanco = e?.response?.status === 402;
      onResultado({
        succeeded: false,
        status: delBanco ? 'requires_payment_method' : 'error',
        titulo: delBanco ? undefined : 'No pudimos completar el cobro',
        decline_message: (typeof d === 'string' ? d : d?.message)
          || 'No se pudo completar el cobro.',
        decline_code: d?.decline_code,
      }, stripe);
    } finally {
      setEnviando(false);
    }
  };

  const puede = stripe && (nueva ? Boolean(secreto) : Boolean(elegido));

  return (
    <form className="pago__form" onSubmit={enviar}>
      {resumen}

      <div className="pago__campo">
        <span className="pago__label">Con qué pagas</span>
        <div className="pago__metodos">
          {(metodos || []).map((m) => (
            <button
              type="button"
              key={m.id}
              className="pago-opcion"
              aria-pressed={elegido === m.id}
              onClick={() => setElegido(m.id)}
            >
              <Tarjeta metodo={m} activa={elegido === m.id} />
            </button>
          ))}
          <button
            type="button"
            className="pago-opcion pago-opcion--nueva"
            aria-pressed={nueva}
            onClick={pedirTarjetaNueva}
          >
            <IconPlus size={15} />
            <span>{metodos?.length ? 'Usar otra tarjeta' : 'Añadir una tarjeta'}</span>
          </button>
        </div>
      </div>

      {nueva && (
        secreto
          ? <div className="pago__elements"><PaymentElement options={{ layout: 'tabs' }} /></div>
          : <p className="pago__cargando">Preparando el formulario seguro…</p>
      )}

      {extra}

      {guardarFijo ? (
        <p className="pago__nota-guardar">
          <span className="pago__tick" aria-hidden="true"><IconCheck size={12} /></span>
          {notaGuardar}
        </p>
      ) : (
        <label className="pago__guardar">
          <input
            type="checkbox"
            checked={guardar}
            onChange={(e) => setGuardar(e.target.checked)}
          />
          <span className="pago__tick" aria-hidden="true"><IconCheck size={12} /></span>
          <span>Guardar esta tarjeta para los próximos cobros</span>
        </label>
      )}

      {error && <p className="pago__error" role="alert">{error}</p>}

      <button className="pago__cta" type="submit" disabled={!puede || enviando}>
        {enviando ? 'Procesando…' : etiquetaAccion}
      </button>
    </form>
  );
}

function Aprobado({ resultado, concepto, onCerrar }) {
  return (
    <div className="pago__desenlace">
      <span className="pago__icono is-ok"><IconCheck size={20} /></span>
      <div className="pago__titulo-grupo">
        <span className="pago__titular">Pago aprobado</span>
        <span className="pago__sub">{concepto}</span>
      </div>
      <div className="pago__detalle">
        <div><span>Importe</span><span>{fmtUSD(resultado.amount)}</span></div>
        {resultado.last4 && <div><span>Tarjeta</span><span>•••• {resultado.last4}</span></div>}
        <div><span>Referencia</span><span className="mono">{resultado.payment_intent}</span></div>
      </div>
      <div className="pago__botones">
        <button className="pago__cta" onClick={onCerrar}>Volver a lixbon</button>
        {resultado.receipt_url && (
          <a className="pago__btn" href={resultado.receipt_url} target="_blank" rel="noreferrer">
            <IconDownload size={15} /> Descargar recibo
          </a>
        )}
      </div>
    </div>
  );
}

// El título lo manda el resultado cuando el cobro no cerró por algo que no fue
// el banco: dar por rechazado lo que no sabemos afirma algo que el emisor nunca
// dijo, y manda al usuario a cambiar una tarjeta que estaba bien.
function Rechazado({ resultado, onReintentar, onCerrar }) {
  const rechazo = Boolean(resultado.decline_code || resultado.status === 'requires_payment_method');
  return (
    <div className="pago__desenlace">
      <span className="pago__icono is-bad"><IconAlert size={20} /></span>
      <div className="pago__titulo-grupo">
        <span className="pago__titular">
          {resultado.titulo || (rechazo ? 'El banco rechazó el cobro' : 'No pudimos completar el cobro')}
        </span>
        <span className="pago__sub">
          {rechazo
            ? 'No se cobró nada. Puedes intentarlo con otra tarjeta.'
            : 'Si se llegó a cobrar, lo verás en Ajustes → Facturación.'}
        </span>
      </div>
      {resultado.decline_message && (
        <div className="pago__motivo">
          <span className="pago__icono-min"><IconAlert size={14} /></span>
          <span className="pago__motivo-txt">
            <span>{resultado.decline_message}</span>
            {resultado.decline_code && (
              <span className="pago__sub">Motivo del emisor · {resultado.decline_code}</span>
            )}
          </span>
        </div>
      )}
      <div className="pago__botones">
        <button className="pago__cta" onClick={onReintentar}>
          {rechazo ? 'Probar con otra tarjeta' : 'Volver a intentarlo'}
        </button>
        <button className="pago__btn" onClick={onCerrar}>Cancelar</button>
      </div>
    </div>
  );
}

function Banco() {
  return (
    <div className="pago__desenlace">
      <span className="pago__icono is-espera"><IconShield size={20} /></span>
      <div className="pago__titulo-grupo">
        <span className="pago__titular">Confirma con tu banco</span>
        <span className="pago__sub">
          Tu banco abrió su propia ventana para verificar que eres tú. Termínala ahí:
          lixbon no ve ni recibe ese código.
        </span>
      </div>
      <p className="pago__sub">No cierres esta ventana: el cobro está en curso.</p>
    </div>
  );
}

export function DialogoPago({
  titulo = 'Pagar',
  concepto,
  resumen,
  extra,
  etiquetaAccion,
  guardarFijo = false,
  notaGuardar = 'Se guarda esta tarjeta: es con la que se renovará tu plan.',
  cobrar,
  onHecho,
  onCerrar,
}) {
  const [stripe, setStripe] = useState(null);
  const [metodos, setMetodos] = useState(null);
  const [elegido, setElegido] = useState(null);
  const [secreto, setSecreto] = useState(null);
  const [guardar, setGuardar] = useState(true);
  const [fase, setFase] = useState('form');
  const [resultado, setResultado] = useState(null);
  const [error, setError] = useState('');
  const { cerrando, cerrar } = useCierreAnimado(onCerrar);

  useEffect(() => { cargarStripe().then(setStripe); }, []);

  useEffect(() => {
    api.get('/api/billing/payment-methods')
      .then((res) => {
        const lista = res.data.payment_methods || [];
        setMetodos(lista);
        setElegido(lista.find((m) => m.is_default)?.id || lista[0]?.id || 'nueva');
      })
      .catch(() => { setMetodos([]); setElegido('nueva'); });
  }, []);

  const pedirTarjetaNueva = useCallback(() => {
    setElegido('nueva');
    if (secreto) return;
    api.post('/api/billing/setup-intent')
      .then((res) => setSecreto(res.data.client_secret))
      .catch((e) => setError(errMsg(e, 'No se pudo preparar el formulario de tarjeta.')));
  }, [secreto]);

  useEffect(() => {
    if (elegido === 'nueva' && !secreto) pedirTarjetaNueva();
  }, [elegido, secreto, pedirTarjetaNueva]);

  // El resultado del servidor puede pedir un paso más por el banco; solo
  // después de resolverlo se sabe si el cobro entró.
  const onResultado = async (res, sdk) => {
    if (res.succeeded) {
      setResultado(res);
      setFase('aprobado');
      onHecho?.(res);
      return;
    }
    if (res.requires_action && !res.client_secret) {
      setResultado({
        ...res,
        titulo: 'El cobro quedó a la espera',
        decline_message: res.decline_message
          || 'La pasarela no devolvió con qué confirmar el cobro desde aquí.',
      });
      setFase('rechazado');
      return;
    }
    if (res.requires_action && res.client_secret && sdk) {
      setFase('banco');
      const { error: fallo, paymentIntent } = await sdk.confirmCardPayment(res.client_secret);
      if (fallo) {
        setResultado({
          ...res,
          decline_message: fallo.message,
          decline_code: fallo.decline_code || fallo.code,
        });
        setFase('rechazado');
        return;
      }
      try {
        const cerrado = await api.post('/api/billing/resolve', {
          payment_intent_id: paymentIntent.id,
        });
        setResultado(cerrado.data);
        setFase(cerrado.data.succeeded ? 'aprobado' : 'rechazado');
        if (cerrado.data.succeeded) onHecho?.(cerrado.data);
      } catch (e) {
        setResultado({ ...res, decline_message: errMsg(e, 'No se pudo confirmar el cobro.') });
        setFase('rechazado');
      }
      return;
    }
    setResultado(res);
    setFase('rechazado');
  };

  const reintentar = () => {
    setResultado(null);
    setError('');
    setFase('form');
    pedirTarjetaNueva();
  };

  return (
    <div
      className={cerrando ? 'pago-overlay is-closing' : 'pago-overlay'}
      onClick={fase === 'banco' ? undefined : cerrar}
    >
      <div className="pago" onClick={(e) => e.stopPropagation()}>
        <span className="pago__tab" aria-hidden="true" />
        <div className="pago__caja">
          <div className="pago__head">
            <div className="pago__marca">
              <LogoMark size={24} />
              <span className="pago__nombre">{titulo}</span>
            </div>
            {fase !== 'banco' && (
              <button className="icon-btn" onClick={cerrar} aria-label="Cerrar"><IconX /></button>
            )}
          </div>

          {fase === 'form' && (
            <Elements
              key={secreto || 'sin-secreto'}
              stripe={stripe}
              options={secreto
                ? { clientSecret: secreto, appearance: apariencia() }
                : undefined}
            >
              <Cuerpo
                resumen={resumen}
                extra={extra}
                etiquetaAccion={etiquetaAccion}
                guardarFijo={guardarFijo}
                notaGuardar={notaGuardar}
                metodos={metodos}
                elegido={elegido}
                setElegido={setElegido}
                secreto={secreto}
                pedirTarjetaNueva={pedirTarjetaNueva}
                guardar={guardar}
                setGuardar={setGuardar}
                cobrar={cobrar}
                onResultado={onResultado}
                error={error}
                setError={setError}
              />
            </Elements>
          )}
          {fase === 'banco' && <Banco />}
          {fase === 'aprobado' && (
            <Aprobado resultado={resultado} concepto={concepto} onCerrar={cerrar} />
          )}
          {fase === 'rechazado' && (
            <Rechazado resultado={resultado} onReintentar={reintentar} onCerrar={cerrar} />
          )}

          <p className="pago__pie">
            <IconShield size={13} />
            <span>
              Pago cifrado y procesado por Stripe. El número de tu tarjeta no pasa
              por lixbon.
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}
