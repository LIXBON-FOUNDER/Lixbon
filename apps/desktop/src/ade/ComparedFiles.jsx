import { FileIcon } from '@lixbon/icons/file-icons';
import { attemptLetter } from './attemptFormat';

/** Proyección de las listas de archivos del Core: no calcula git, solapes ni sumas entre intentos. */
export function ComparedFiles({ comparison }) {
  const paths = new Map();
  let complete = true;
  for (const attempt of comparison.attempts) {
    if (attempt.changes.files.provenance === 'unknown' || attempt.changes.truncated) complete = false;
    for (const file of attempt.changes.list) {
      const members = paths.get(file.path) || [];
      members.push({ ...file, letter: attemptLetter(attempt.n), id: attempt.attempt_id });
      paths.set(file.path, members);
    }
  }
  return <div className="ade-compared-files scroll" aria-label="Archivos de los intentos comparados">
    <p>{paths.size} archivos {complete ? 'cambiados entre los intentos' : 'informados · listas parciales'}</p>
    {Array.from(paths).sort(([a], [b]) => a.localeCompare(b)).map(([path, members]) => <div className="ade-compared-file" key={path} title={path}>
      <FileIcon nombre={path} size={16} />
      <div><span className="ade-compared-file__name">{path.split('/').pop()}</span><small>{members.length === 1 ? `solo ${members[0].letter}` : members.map(m => m.letter).join(' y ')}</small>
        <details><summary>Ver cambios por intento</summary>{members.map(m => <p key={m.id}>{m.letter}: {m.additions === null || m.deletions === null ? 'archivo binario' : <><span className="is-add">+{m.additions}</span> <span className="is-del">−{m.deletions}</span></>}</p>)}</details>
      </div>
      {members.length === 1 && members[0].additions !== null && members[0].deletions !== null && <span className="ade-compared-file__stat"><em className="is-add">+{members[0].additions}</em> <em className="is-del">−{members[0].deletions}</em></span>}
    </div>)}
    {paths.size === 0 && <p>{complete ? 'No hay archivos cambiados en estos intentos.' : 'Los archivos no están informados.'}</p>}
  </div>;
}
