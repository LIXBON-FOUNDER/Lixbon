// Skeleton.jsx — placeholder con shimmer para estados de carga.
export function Skeleton({ w, h = 14, r = 8, className = '', style = {} }) {
  return (
    <span
      className={`skeleton ${className}`}
      style={{ width: w, height: h, borderRadius: r, ...style }}
      aria-hidden="true"
    />
  );
}

// Skeleton del historial de conversaciones (sidebar).
export function HistorySkeleton({ rows = 6 }) {
  return (
    <div className="sk-history" aria-label="Cargando historial">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} w={`${88 - (i % 3) * 14}%`} h={15} style={{ margin: '9px 10px' }} />
      ))}
    </div>
  );
}

// Skeleton del hilo de mensajes (al abrir una conversación).
export function ThreadSkeleton() {
  return (
    <div className="sk-thread" aria-label="Cargando conversación">
      <div className="sk-msg sk-msg--user">
        <Skeleton w="52%" h={16} r={14} />
      </div>
      <div className="sk-msg sk-msg--assistant">
        <Skeleton w="90%" h={14} />
        <Skeleton w="96%" h={14} />
        <Skeleton w="74%" h={14} />
      </div>
      <div className="sk-msg sk-msg--user">
        <Skeleton w="38%" h={16} r={14} />
      </div>
      <div className="sk-msg sk-msg--assistant">
        <Skeleton w="84%" h={14} />
        <Skeleton w="92%" h={14} />
      </div>
    </div>
  );
}

// Skeleton del contenido de la documentación.
export function DocsSkeleton() {
  return (
    <div className="sk-docs" aria-label="Cargando documentación">
      <Skeleton w="46%" h={30} r={10} />
      <Skeleton w="88%" h={16} style={{ marginTop: 14 }} />
      <Skeleton w="70%" h={16} />
      <Skeleton w="34%" h={20} r={8} style={{ marginTop: 26 }} />
      <Skeleton w="94%" h={14} style={{ marginTop: 10 }} />
      <Skeleton w="90%" h={14} />
      <Skeleton w="80%" h={14} />
      <Skeleton w="100%" h={48} r={14} style={{ marginTop: 16 }} />
      <Skeleton w="30%" h={20} r={8} style={{ marginTop: 26 }} />
      <Skeleton w="92%" h={14} style={{ marginTop: 10 }} />
      <Skeleton w="86%" h={14} />
    </div>
  );
}
