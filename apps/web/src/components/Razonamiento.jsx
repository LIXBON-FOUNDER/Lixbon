// Pie del cuadro de mensaje: un solo menú para el modelo y su razonamiento.
// El botón dice «modelo · nivel»; dentro, la lista de modelos y, debajo, la
// fila «Razonamiento» que abre al lado el deslizador con los niveles que
// admite el modelo (el gateway publica `reasoning: toggle|levels` en
// /v1/models). «Auto» deja que decida el gateway según el mensaje.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconChevron, IconX } from './Icons';
import { useDismiss } from '../hooks/useDismiss';
import { useSalida } from '../hooks/useSalida';
import { useT } from '../i18n/useT';
import { cuando } from '../lib/cuando';
import { Link } from '../i18n/link';
import { Aviso } from './Pulido';

const ETIQUETA = { auto: 'effortAuto', off: 'effortOff', on: 'effortOn', low: 'effortLow', medium: 'effortMedium', high: 'effortHigh' };
const ANCHO_SUB = 280;
const MARGEN = 8;

// Pista por niveles con una píldora que se arrastra: sigue al dedo o al
// ratón y, al soltar, se asienta en el nivel más cercano con una curva suave.
// Un clic en un nivel la desliza hasta él. Teclado: flechas, Inicio y Fin.
function Deslizador({ niveles, valor, onChange }) {
  const t = useT('chat');
  const actual = niveles.includes(valor) ? valor : 'auto';
  const indice = niveles.indexOf(actual);
  const n = niveles.length;
  const pista = useRef(null);
  const [arrastre, setArrastre] = useState(null); // {pos, x0, movido} mientras se arrastra
  const posDe = (clientX) => {
    const r = pista.current.getBoundingClientRect();
    return Math.min(n - 1, Math.max(0, ((clientX - r.left) / r.width) * n - 0.5));
  };
  const bajar = (e) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setArrastre({ pos: posDe(e.clientX), x0: e.clientX, movido: false });
  };
  const mover = (e) => {
    if (!arrastre) return;
    setArrastre({ ...arrastre, pos: posDe(e.clientX), movido: arrastre.movido || Math.abs(e.clientX - arrastre.x0) > 3 });
  };
  const soltar = (e) => {
    if (!arrastre) return;
    const i = Math.round(posDe(e.clientX));
    setArrastre(null);
    if (niveles[i] && niveles[i] !== actual) onChange(niveles[i]);
  };
  const tecla = (e) => {
    const paso = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    let i = paso ? indice + paso : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : indice;
    i = Math.min(n - 1, Math.max(0, i));
    if (i !== indice) { e.preventDefault(); onChange(niveles[i]); }
  };
  const pos = arrastre ? arrastre.pos : indice;
  const cerca = Math.round(pos);
  const activo = !['auto', 'off'].includes(niveles[cerca]);
  return (
    <>
      <p className="razonar__etq">{t('effortTitle')}</p>
      <div
        ref={pista}
        className={`razonar__pista ${arrastre?.movido ? 'is-arrastre' : ''} ${activo ? 'is-activo' : ''}`}
        style={{ '--n': n, '--pos': pos }}
        role="slider"
        tabIndex={0}
        aria-label={t('effortTitle')}
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={indice}
        aria-valuetext={t(ETIQUETA[actual])}
        onPointerDown={bajar}
        onPointerMove={mover}
        onPointerUp={soltar}
        onPointerCancel={() => setArrastre(null)}
        onKeyDown={tecla}
      >
        <span className="razonar__pildora" aria-hidden="true" />
        {niveles.map((nv, i) => (
          <span key={nv} className={`razonar__marca ${i === cerca ? 'is-sel' : ''}`}>{t(ETIQUETA[nv])}</span>
        ))}
      </div>
    </>
  );
}

// `apagados`: modelos que se ven pero no se pueden elegir ahora ({ id: motivo }).
export function ModeloMenu({ models, modelInfo = {}, model, onModelChange, niveles = [], razonar = 'auto', onRazonar, apagados = {} }) {
  const t = useT('chat');
  const [abierto, setAbierto] = useState(false);
  const [sub, setSub] = useState(false);
  const [lado, setLado] = useState({ abajo: false, izq: false });
  const raiz = useRef(null);
  const panel = useRef(null);
  const cerrar = useCallback(() => { setAbierto(false); setSub(false); }, []);
  useDismiss(abierto, raiz, cerrar);
  const salida = useSalida(abierto, 140);
  const salidaSub = useSalida(abierto && sub, 140);

  // Se abre hacia donde haya sitio: abajo si cabe (el cuadro está arriba en
  // la portada) y el deslizador a la derecha salvo que se salga de la ventana.
  useLayoutEffect(() => {
    if (!abierto) return;
    const btn = raiz.current?.getBoundingClientRect();
    const p = panel.current?.getBoundingClientRect();
    if (!btn || !p) return;
    const abajo = window.innerHeight - btn.bottom - MARGEN >= p.height;
    const izq = p.right + ANCHO_SUB + MARGEN > window.innerWidth;
    setLado((l) => (l.abajo === abajo && l.izq === izq ? l : { abajo, izq }));
  }, [abierto]);

  const conRazonar = Boolean(onRazonar) && niveles.length > 0;
  const actual = niveles.includes(razonar) ? razonar : 'auto';
  const nombre = modelInfo[model]?.name || model;

  const elegir = (m) => {
    if (m !== model) onModelChange(m);
    cerrar();
  };

  // Triángulo seguro: al ir en diagonal de «Razonamiento» a su deslizador el
  // cursor cruza los modelos de encima. Cerrarlo al instante cambiaría de
  // sección sin querer; se espera un momento y, si llega al deslizador, sigue.
  const espera = useRef(null);
  const cerrarSubLuego = () => {
    clearTimeout(espera.current);
    espera.current = setTimeout(() => setSub(false), 280);
  };
  const seguirSub = () => clearTimeout(espera.current);
  useEffect(() => () => clearTimeout(espera.current), []);

  // Debajo del nombre, para qué sirve: lo que de verdad declara el modelo.
  const detalle = (m) => {
    const info = modelInfo[m] || {};
    const caps = info.capabilities || [];
    const partes = [];
    if (caps.includes('thinking')) partes.push(t('capThinking'));
    if (caps.includes('vision')) partes.push(t('capVision'));
    if (caps.includes('tools')) partes.push(t('capTools'));
    if (info.num_ctx) partes.push(t('capCtx', { n: info.num_ctx >= 1000 ? `${Math.round(info.num_ctx / 1000)}k` : info.num_ctx }));
    return partes.join(' · ');
  };

  return (
    <div className="modelo-menu" ref={raiz}>
      <button
        type="button"
        className={`modelo-menu__btn ${abierto ? 'is-open' : ''}`}
        onClick={() => (abierto ? cerrar() : setAbierto(true))}
        aria-haspopup="menu"
        aria-expanded={abierto}
        aria-label={t('modelMenuAria')}
      >
        <span className="modelo-menu__nombre">{nombre}</span>
        {conRazonar && <span className={`modelo-menu__nivel ${actual !== 'auto' && actual !== 'off' ? 'is-on' : ''}`}>{t(ETIQUETA[actual])}</span>}
        <IconChevron size={16} open={abierto} className="modelo-menu__chevron" />
      </button>

      {salida.montado && (
        <div
          ref={panel}
          className={`modelo-menu__panel ${lado.abajo ? 'is-abajo' : 'is-arriba'} ${salida.cerrando ? 'is-cerrando' : ''}`}
          role="menu"
          aria-label={t('modelMenuAria')}
        >
          <p className="modelo-menu__etq">{t('modelsTitle')}</p>
          <div className="modelo-menu__lista">
            {[...models, ...Object.keys(apagados).filter((m) => !models.includes(m))].map((m) => {
              const off = Object.prototype.hasOwnProperty.call(apagados, m);
              const det = off ? apagados[m] : detalle(m);
              return (
                <button
                  key={m}
                  type="button"
                  role="menuitemradio"
                  aria-checked={m === model}
                  disabled={off}
                  className={`modelo-menu__opt ${m === model ? 'is-sel' : ''} ${off ? 'nv-off' : ''}`}
                  onPointerEnter={(e) => { if (e.pointerType === 'mouse' && sub) cerrarSubLuego(); }}
                  onClick={() => elegir(m)}
                >
                  <span className="modelo-menu__txt">
                    <span className="modelo-menu__nom">{modelInfo[m]?.name || m}</span>
                    {det && <span className="modelo-menu__det">{det}</span>}
                  </span>
                </button>
              );
            })}
          </div>

          {conRazonar && (
            <div className="modelo-menu__bloque">
              <button
                type="button"
                role="menuitem"
                aria-haspopup="dialog"
                aria-expanded={sub}
                className={`modelo-menu__opt modelo-menu__fila ${sub ? 'is-active' : ''}`}
                onPointerEnter={(e) => { if (e.pointerType === 'mouse') { seguirSub(); setSub(true); } }}
                // Abrir, no alternar: con ratón el paso por encima ya lo abrió
                // y un clic que lo cerrara parecería que no responde.
                onClick={() => setSub(true)}
              >
                <span className="modelo-menu__txt">{t('effortTitle')}</span>
                <span className="modelo-menu__valor">{t(ETIQUETA[actual])}</span>
                <IconChevron size={14} className="modelo-menu__flecha" style={{ transform: `rotate(${lado.izq ? 90 : -90}deg)` }} />
              </button>
              {salidaSub.montado && (
                <div
                  className={`modelo-menu__sub ${lado.izq ? 'is-izq' : ''} ${salidaSub.cerrando ? 'is-cerrando' : ''}`}
                  role="dialog"
                  aria-label={t('effortTitle')}
                  onPointerEnter={seguirSub}
                >
                  <Deslizador niveles={niveles} valor={razonar} onChange={onRazonar} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AvisoCuota({ aviso, onCerrar }) {
  const t = useT('chat');
  if (!aviso) return null;
  const idioma = document.documentElement.lang || 'es';
  const semana = aviso.scope === 'week';
  const agotado = aviso.state === 'exhausted';
  const titulo = agotado
    ? t('quotaExhausted', { scope: t(semana ? 'quotaExWeek' : 'quotaExSession') })
    : t('quotaNear', { left: Math.max(0, 100 - Math.round(aviso.percent || 0)), scope: t(semana ? 'quotaNearWeek' : 'quotaNearSession') });
  const texto = aviso.reset_at ? t('quotaResets', { when: cuando(aviso.reset_at, idioma) }) : '';
  // Ámbar si queda poco; rojo si ya no queda. Una línea, acciones a la derecha.
  return (
    <Aviso tipo={agotado ? 'mal' : 'warn'} icono="uso" titulo={titulo} texto={texto} className="aviso-cuota-nuevo"
      acciones={(
        <>
          <Link to="/account/usage" className="pill-btn pill-btn--outline">{t('seeUsage')}</Link>
          <button type="button" className="pill-btn pill-btn--ghost pill-btn--icono" onClick={onCerrar} aria-label={t('quotaDismiss')} title={t('quotaDismiss')}>
            <IconX size={14} />
          </button>
        </>
      )} />
  );
}
