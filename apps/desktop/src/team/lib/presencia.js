export const ESTADOS = [
  {
    id: 'en_linea',
    label: 'En línea',
    ayuda: 'Disponible. Es lo normal mientras Team está abierto.',
    color: 'var(--good)',
  },
  {
    id: 'no_molestar',
    label: 'No molestar',
    ayuda: 'Sigues conectado, pero se ve que ahora no es buen momento.',
    color: 'var(--warn)',
  },
  {
    id: 'invisible',
    label: 'Invisible',
    ayuda: 'Los demás te ven desconectado. Tú sigues recibiéndolo todo.',
    color: 'var(--ink-35)',
    hueco: true,
  },
  {
    id: 'desconectado',
    label: 'Desconectado',
    ayuda: 'Ni recibes avisos ni apareces disponible.',
    color: 'var(--ink-35)',
  },
];

export function estadoDef(id) {
  return ESTADOS.find((e) => e.id === id) || ESTADOS[3];
}

export const etiquetaEstado = (id) => estadoDef(id).label;
