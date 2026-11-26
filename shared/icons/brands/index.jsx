import BRANDS from './data.js';

const ALIASES = { codex: 'openai', chatgpt: 'openai', 'claude-code': 'claude', anthropic: 'claude' };

/** Marcas del lienzo, sin pastilla ni fondo. Los proveedores desconocidos no inventan una marca. */
export function BrandIcon({ name, size = 16, className = '', ...props }) {
  const key = String(name || '').toLowerCase();
  const brand = BRANDS[ALIASES[key] || key];
  if (!brand) return null;
  return <svg width={size} height={size} viewBox={brand.viewBox} className={`brand-icon ${className}`.trim()} data-brand={ALIASES[key] || key} aria-hidden="true" focusable="false" style={{ flex: 'none' }} dangerouslySetInnerHTML={{ __html: brand.body }} {...props} />;
}
