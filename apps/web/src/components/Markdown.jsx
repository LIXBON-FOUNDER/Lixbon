// Markdown.jsx — render de respuestas de la IA. Títulos en Semibold según diseño.
import ReactMarkdown from 'react-markdown';

export function Markdown({ children }) {
  return (
    <div className="md">
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  );
}
