import { useT } from '../i18n/useT';

export function Skeleton({ w, h = 14, r = 8, i, className = '', style = {} }) {
  return (
    <span
      className={`skeleton ${className}`}
      style={{ width: w, height: h, borderRadius: r, '--i': i, ...style }}
      aria-hidden="true"
    />
  );
}

export function HistorySkeleton({ rows = 6 }) {
  const t = useT('chat');
  return (
    <div className="sk-history" aria-label={t('loadingHistory')}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} i={i} w={`${88 - (i % 3) * 14}%`} h={15} />
      ))}
    </div>
  );
}

export function ThreadSkeleton() {
  const t = useT('chat');
  return (
    <div className="sk-thread" aria-label={t('loadingConversation')}>
      <div className="sk-msg sk-msg--user">
        <Skeleton i={0} w="52%" h={16} />
      </div>
      <div className="sk-msg sk-msg--assistant">
        <Skeleton i={1} w="90%" h={14} />
        <Skeleton i={2} w="96%" h={14} />
        <Skeleton i={3} w="74%" h={14} />
      </div>
      <div className="sk-msg sk-msg--user">
        <Skeleton i={4} w="38%" h={16} />
      </div>
      <div className="sk-msg sk-msg--assistant">
        <Skeleton i={5} w="84%" h={14} />
        <Skeleton i={6} w="92%" h={14} />
        <Skeleton i={7} w="100%" h={52} />
        <Skeleton i={8} w="66%" h={14} />
      </div>
    </div>
  );
}

export function DocsSkeleton() {
  const t = useT('chat');
  return (
    <div className="sk-docs" aria-label={t('loadingDocs')}>
      <Skeleton w="46%" h={30} />
      <Skeleton w="88%" h={16} style={{ marginTop: 14 }} />
      <Skeleton w="70%" h={16} />
      <Skeleton w="34%" h={20} style={{ marginTop: 26 }} />
      <Skeleton w="94%" h={14} style={{ marginTop: 10 }} />
      <Skeleton w="90%" h={14} />
      <Skeleton w="80%" h={14} />
      <Skeleton w="100%" h={48} style={{ marginTop: 16 }} />
      <Skeleton w="30%" h={20} style={{ marginTop: 26 }} />
      <Skeleton w="92%" h={14} style={{ marginTop: 10 }} />
      <Skeleton w="86%" h={14} />
    </div>
  );
}
