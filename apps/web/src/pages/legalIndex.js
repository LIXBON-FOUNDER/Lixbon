// legalIndex.js — índice de los documentos legales (sin JSX: lo lee el sitemap).
// id es el mismo en los dos idiomas; title/description cambian.
export const LEGAL_INDEX = [
  { id: 'privacy',
    title: { es: 'Política de privacidad', en: 'Privacy policy' },
    description: {
      es: 'Qué datos personales trata lixbon, con qué finalidad, cuánto tiempo, a quién se transfieren y cómo ejercer tus derechos (Ley 1581 de 2012).',
      en: 'What personal data lixbon processes, for what purpose, for how long, who it’s shared with, and how to exercise your rights (Colombian Law 1581 of 2012).',
    } },
  { id: 'terms',
    title: { es: 'Términos y condiciones', en: 'Terms and conditions' },
    description: {
      es: 'Condiciones de uso de lixbon: cuenta, planes y pagos, uso aceptable, API, contenido generado por IA, propiedad y responsabilidad.',
      en: 'Terms of use for lixbon: account, plans and payments, acceptable use, API, AI-generated content, ownership and liability.',
    } },
  { id: 'refunds',
    title: { es: 'Cancelaciones y reembolsos', en: 'Cancellations and refunds' },
    description: {
      es: 'Cómo cancelar un plan, qué pasa con el periodo pagado, cuándo procede un reembolso y qué ocurre con los créditos de la API.',
      en: 'How to cancel a plan, what happens to the paid period, when a refund applies, and what happens to API credits.',
    } },
];
