import { useMemo } from 'react';

/**
 * Teclado de un árbol ARIA (roving tabindex) sobre nodos `{kind, id}` visibles en orden.
 *
 * Cada nodo: `{ key, kind, id, parentKey, expandable, expanded, firstChildKey }`. El hook no lee
 * ni escribe nada del Core: solo decide a qué nodo pasa el foco o qué nodo se expande/pliega
 * (estado de presentación). Se usa en el sidebar Project → Task → Attempt (LXO-97/LXO-120).
 *
 * · ↑/↓ Inicio/Fin recorren los nodos visibles.
 * · → expande un nodo plegado; si ya está expandido, baja a su primer hijo.
 * · ← pliega un nodo expandido; si no, sube a su padre.
 */
export function useTreeNavigation({ nodes, focusKey, setExpanded }) {
  const index = useMemo(() => new Map(nodes.map((node, position) => [node.key, position])), [nodes]);
  return (event, key) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const position = index.get(key);
    if (position === undefined) return;
    const node = nodes[position];
    let nextKey = null;
    switch (event.key) {
      case 'ArrowDown': nextKey = nodes[position + 1]?.key ?? null; break;
      case 'ArrowUp': nextKey = nodes[position - 1]?.key ?? null; break;
      case 'Home': nextKey = nodes[0]?.key ?? null; break;
      case 'End': nextKey = nodes[nodes.length - 1]?.key ?? null; break;
      case 'ArrowRight':
        if (node.expandable && !node.expanded) setExpanded(node, true);
        else if (node.expanded) nextKey = node.firstChildKey ?? null;
        break;
      case 'ArrowLeft':
        if (node.expandable && node.expanded) setExpanded(node, false);
        else nextKey = node.parentKey ?? null;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (nextKey) focusKey(nextKey);
  };
}
