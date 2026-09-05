// DocsToc.jsx — índice de la página que se está leyendo ("En esta página").
//
// Los títulos no se declaran en ningún sitio: viven dentro del cuerpo de cada
// sección (docsContent.jsx), que es prosa suelta. Así que se leen del DOM ya
// pintado, se les pone un ancla estable y se observa cuál está en pantalla.
// Si la sección no tiene títulos, la columna no se dibuja.
import { useEffect, useState } from 'react';

// "URL base y puertos" → "url-base-y-puertos"
function anclaDe(texto, i) {
  const slug = texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // los acentos que NFD acaba de separar
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug ? `s-${slug}` : `s-${i}`;
}

export function DocsToc({ contenedor, deps }) {
  const [titulos, setTitulos] = useState([]);
  const [activo, setActivo] = useState('');

  useEffect(() => {
    const raiz = contenedor.current;
    if (!raiz) return undefined;

    const encontrados = Array.from(raiz.querySelectorAll('h2')).map((el, i) => {
      el.id = el.id || anclaDe(el.textContent || '', i);
      return { id: el.id, texto: el.textContent || '' };
    });
    setTitulos(encontrados);
    setActivo(encontrados[0]?.id || '');
    if (encontrados.length === 0) return undefined;

    // El margen inferior deja fuera todo lo que va por debajo del primer
    // tercio: sin él, al llegar al final de la página se marcarían activos
    // tres títulos a la vez.
    const obs = new IntersectionObserver(
      (entradas) => {
        const visible = entradas
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActivo(visible.target.id);
      },
      { rootMargin: '0px 0px -66% 0px', threshold: 0 },
    );
    raiz.querySelectorAll('h2').forEach((el) => obs.observe(el));
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contenedor, deps]);

  if (titulos.length === 0) return null;

  return (
    <aside className="docs__toc" aria-label="En esta página">
      <span className="docs__toc-title">En esta página</span>
      {titulos.map((t) => (
        <a
          key={t.id}
          href={`#${t.id}`}
          className={`docs__toc-link ${t.id === activo ? 'is-active' : ''}`}
          onClick={(e) => {
            e.preventDefault();
            document.getElementById(t.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            setActivo(t.id);
          }}
        >
          {t.texto}
        </a>
      ))}
    </aside>
  );
}
