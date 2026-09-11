// ClusterCaido.jsx — la ilustración de la página no encontrada.
//
// El mismo clúster de ClusterFondo, contado al revés: las aristas se trazan al
// cargar, los nodos aparecen y respiran, las peticiones viajan y, cada 18 s,
// un nodo se apaga en rojo y sus aristas se desvanecen. La ruta que no existe
// es ese nodo. El grafo ocupa la mitad derecha para no pisar el texto.

// [x1, y1, x2, y2, retardo del trazado en s, aislable]. Las tres aristas del
// nodo J (1000,560) son las que se apagan con él.
const ARISTAS = [
  [300, 210, 540, 90, 0], [300, 210, 760, 120, 0.1], [540, 90, 760, 120, 0.2],
  [760, 120, 980, 210, 0.3], [980, 210, 1220, 150, 0.45], [980, 210, 860, 420, 0.45],
  [1220, 150, 1330, 330, 0.6], [1330, 330, 1160, 460, 0.7], [860, 420, 1160, 460, 0.7],
  [1160, 460, 1310, 640, 0.85], [1310, 640, 1130, 780, 1], [1130, 780, 900, 700, 1.1],
  [900, 700, 1000, 560, 1.15, true], [1000, 560, 1160, 460, 1.15, true], [1000, 560, 860, 420, 1.15, true],
];

// [cx, cy, grande]. Los dos grandes son los nodos con GPU.
const NODOS = [
  [300, 210], [540, 90], [760, 120], [980, 210, true], [1220, 150], [1330, 330],
  [860, 420], [1160, 460, true], [1310, 640], [1130, 780], [900, 700], [1000, 560],
];

// Peticiones en vuelo: [cx, cy, animación, duración, retardo].
const VIAJES = [
  [760, 120, 'caido-ab', '5.5s', '2s'],
  [1220, 150, 'caido-cd', '6.5s', '3.4s'],
  [1310, 640, 'caido-fe', '6s', '4.8s'],
  [540, 90, 'caido-ka', '7s', '2.7s'],
];

export function ClusterCaido() {
  return (
    <svg
      className="cluster"
      viewBox="0 0 1440 900"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <g stroke="#232320" strokeWidth="1" fill="none">
        {ARISTAS.map(([x1, y1, x2, y2, retardo, aislable], i) => (
          <line
            key={i}
            className={`caido__arista ${aislable ? 'caido__arista--j' : ''}`}
            pathLength="1"
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            style={{ animationDelay: aislable ? `${retardo}s, 2s` : `${retardo}s` }}
          />
        ))}
      </g>

      {NODOS.map(([cx, cy, grande], i) => (
        <circle
          key={i}
          className="caido__nodo"
          cx={cx}
          cy={cy}
          r={grande ? 6 : 3.5}
          fill={grande ? '#8CA038' : '#6E7A45'}
          style={{ animationDelay: `1.1s, ${1.7 + 0.6 * i}s` }}
        />
      ))}

      <circle className="cluster__roto caido__roto" cx="1000" cy="560" r="7" fill="#C4553D" />

      {VIAJES.map(([cx, cy, anim, dur, delay], i) => (
        <circle
          key={i}
          className="cluster__viaje"
          cx={cx}
          cy={cy}
          r="2"
          fill="#F2F2F0"
          style={{ animation: `${anim} ${dur} cubic-bezier(.4,0,.2,1) infinite ${delay}` }}
        />
      ))}
    </svg>
  );
}
