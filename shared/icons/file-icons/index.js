import React from 'react';
import ICONOS from './nodes.js';
export { iconoDeArchivo, extensionDeArchivo } from './resolver.js';
import { iconoDeArchivo } from './resolver.js';
function render([tag, attrs, children], key) {
  return React.createElement(tag, { ...attrs, key }, ...children.map((c, i) => typeof c === 'string' ? c : render(c, i)));
}
export function FileIcon({ nombre = '', size = 16, style, ...rest }) {
  const [tag, attrs, children] = ICONOS[iconoDeArchivo(nombre)];
  return render([tag, { ...attrs, ...rest, width: size, height: size, 'aria-hidden': true, style: { flexShrink: 0, ...style } }, children]);
}
