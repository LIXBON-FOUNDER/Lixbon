// ClusterFondo.jsx — el fondo de las pantallas de acceso.
//
// Es lo que hace lixbon, dibujado: nodos de la LAN conectados, una petición que
// viaja por la arista hasta el nodo que la va a atender y, cada 18 s, un nodo
// que se cae y queda aislado. CSS y SVG puros, sin librerías; si el sistema
// pide menos movimiento (motion.css) se queda quieto y sigue siendo legible.

const ARISTAS = [
  [130, 180, 300, 300], [300, 300, 170, 520], [170, 520, 340, 660],
  [340, 660, 120, 790], [130, 180, 170, 520], [300, 300, 340, 660],
  [700, 90, 300, 300], [700, 90, 1120, 160], [1120, 160, 1300, 290],
  [1300, 290, 1150, 500], [1150, 500, 1290, 690], [1290, 690, 1110, 810],
  [1120, 160, 1150, 500], [1150, 500, 1110, 810], [740, 830, 340, 660],
  [740, 830, 1290, 690],
];

// [cx, cy, grande]. Los dos grandes son los nodos con GPU del clúster.
const NODOS = [
  [130, 180], [300, 300, true], [170, 520], [340, 660], [120, 790],
  [1120, 160], [1300, 290], [1150, 500, true], [1290, 690], [1110, 810],
  [700, 90], [740, 830],
];

// Peticiones en vuelo: [cx, cy, animación, duración, retardo].
const VIAJES = [
  [130, 180, 'viaje-ab', '5s', '0s'],
  [1300, 290, 'viaje-gh', '6.5s', '1.4s'],
  [700, 90, 'viaje-tf', '7.5s', '2.8s'],
  [740, 830, 'viaje-ui', '6s', '4.1s'],
  [170, 520, 'viaje-cd', '5.5s', '0.7s'],
];

export function ClusterFondo() {
  return (
    <svg
      className="cluster"
      viewBox="0 0 1440 900"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <g stroke="#232320" strokeWidth="1">
        {ARISTAS.map(([x1, y1, x2, y2], i) => (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />
        ))}
      </g>

      {NODOS.map(([cx, cy, grande], i) => (
        <circle
          key={i}
          className="cluster__nodo"
          cx={cx}
          cy={cy}
          r={grande ? 6 : 3.5}
          fill={grande ? '#8CA038' : '#6E7A45'}
          style={{ animationDelay: `${-0.9 * i}s` }}
        />
      ))}

      {/* Un nodo se cae y se aísla; vuelve solo. */}
      <circle className="cluster__roto" cx="1150" cy="500" r="7" fill="#C4553D" />

      {VIAJES.map(([cx, cy, anim, dur, delay], i) => (
        <circle
          key={i}
          className="cluster__viaje"
          cx={cx}
          cy={cy}
          r="3"
          fill="#B4C64E"
          style={{ animation: `${anim} ${dur} cubic-bezier(.5,0,.5,1) infinite ${delay}` }}
        />
      ))}
    </svg>
  );
}
