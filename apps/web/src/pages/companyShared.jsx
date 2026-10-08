import { useState } from 'react';

// Las fotos las sube el equipo a apps/web/public/about/; hasta entonces se ven las iniciales.
export const EQUIPO = [
  {
    nombre: 'Gabriel Durango',
    iniciales: 'GD',
    foto: '/about/gabriel-durango.jpg',
    rol: 'roleGabriel',
    bio: 'bioGabriel',
    enlaces: [
      { label: 'LinkedIn', href: 'https://www.linkedin.com/in/gabriel-durango-36a83934a/' },
      { label: 'GitHub', href: 'https://github.com/gabriel-DgMr' },
    ],
  },
  {
    nombre: 'Adrian Presiga Durango',
    iniciales: 'AP',
    foto: '/about/adrian-presiga.jpg',
    rol: 'roleAdrian',
    bio: 'bioAdrian',
    enlaces: [],
  },
];

export function Retrato({ persona }) {
  const [fallo, setFallo] = useState(false);
  if (fallo) return <span className="empresa__retrato empresa__retrato--iniciales" aria-hidden="true">{persona.iniciales}</span>;
  return <img className="empresa__retrato" src={persona.foto} alt={persona.nombre} loading="lazy" onError={() => setFallo(true)} />;
}
