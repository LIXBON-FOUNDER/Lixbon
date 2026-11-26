/** Resalta la misma subsecuencia que busca el fuzzy, sin HTML ni expresiones del usuario. */
export function SearchHighlight({
  text = '',
  query = ''
}) {
  const wanted = query.toLowerCase().replace(/\s+/g, '');
  if (!wanted) return text;
  let next = 0;
  const runs = [];
  for (const char of String(text)) {
    const matched = next < wanted.length && char.toLowerCase() === wanted[next];
    if (matched) next += 1;
    const previous = runs[runs.length - 1];
    if (previous?.matched === matched) previous.text += char;else runs.push({
      text: char,
      matched
    });
  }
  if (next < wanted.length) return text;
  return runs.map((run, index) => run.matched ? <mark className="search-highlight" key={index}>{run.text}</mark> : run.text);
}
