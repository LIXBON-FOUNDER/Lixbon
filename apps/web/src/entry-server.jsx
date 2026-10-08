import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { AppRoutes, precargarTodo } from './App';
import { tomarSeoDelRender } from './lib/seo';

export const precargar = precargarTodo;

export function render(url) {
  const html = renderToString(
    <StaticRouter location={url}>
      <AppRoutes />
    </StaticRouter>,
  );
  return { html, seo: tomarSeoDelRender() };
}
