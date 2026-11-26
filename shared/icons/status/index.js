import React from 'react';
import ICONOS from './nodes.js';
function render([tag, attrs, children], key) {
  return React.createElement(tag, { ...attrs, key }, ...children.map((c, i) => typeof c === 'string' ? c : render(c, i)));
}
export function StatusIcon({ kind = 'paused', size = 16, label, className = '', ...rest }) {
  const [tag, attrs, children] = ICONOS[kind] || ICONOS.paused;
  return render([tag, { ...attrs, ...rest, width: size, height: size, className: `lx-status ${className}`, 'data-kind': kind, 'aria-hidden': label ? undefined : true, 'aria-label': label, role: label ? 'img' : undefined }, children]);
}
