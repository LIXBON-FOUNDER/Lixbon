// «*palabra*» va en cursiva oliva, como los titulares de founder.
export function Enfasis({ texto }) {
  return texto.split(/(\*[^*]+\*)/).map((parte, i) => (
    parte.startsWith('*') ? <em key={i}>{parte.slice(1, -1)}</em> : parte
  ));
}
