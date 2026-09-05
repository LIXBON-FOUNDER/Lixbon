import { IconCard } from '../Icons';

export const fmtUSD = (v) => `$${Number(v || 0).toFixed(2)}`;

export const errMsg = (e, respaldo) => {
  const d = e?.response?.data?.detail;
  if (typeof d === 'string') return d;
  return d?.message || respaldo;
};

const MARCAS = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
};

export const nombreMarca = (m) => MARCAS[m] || (m ? m[0].toUpperCase() + m.slice(1) : 'Tarjeta');

export const venceEn = (m) => (m.exp_month && m.exp_year
  ? `${String(m.exp_month).padStart(2, '0')}/${String(m.exp_year).slice(-2)}`
  : null);

export function Tarjeta({ metodo, children, activa }) {
  const vence = venceEn(metodo);
  return (
    <div className={`pago-tarjeta ${activa ? 'is-activa' : ''}`}>
      <span className="pago-tarjeta__marca" aria-hidden="true"><IconCard size={17} /></span>
      <span className="pago-tarjeta__datos">
        <span className="pago-tarjeta__linea">
          <span className="pago-tarjeta__num">•••• {metodo.last4}</span>
          {metodo.is_default && <span className="pago-tarjeta__chip">Predeterminada</span>}
        </span>
        <span className="pago-tarjeta__pie">
          {nombreMarca(metodo.brand)}
          {vence && ` · Vence ${vence}`}
          {metodo.name && ` · ${metodo.name}`}
        </span>
      </span>
      {children && <span className="pago-tarjeta__acciones">{children}</span>}
    </div>
  );
}
