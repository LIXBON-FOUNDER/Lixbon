// scopeMap.js — mapa scope TextMate → tags de lezer, compartido entre
// vsTheme.js (temas de VSCode sobre parsers lezer) y textmate.js (gramáticas
// TextMate de extensiones). Mantener ordenado de lo general a lo específico
// no es necesario: quien lo consume busca la regla más específica.
import { tags as t } from '@lezer/highlight';

export const SCOPE_TO_TAGS = [
  // Comentarios
  ['comment', [t.comment, t.lineComment, t.blockComment]],
  ['comment.block.documentation', [t.docComment]],

  // Strings
  ['string', [t.string]],
  ['string.template', [t.special(t.string)]],
  ['string.regexp', [t.regexp]],
  ['constant.character.escape', [t.escape]],
  ['string.quoted.docstring', [t.docString]],

  // Constantes y números
  ['constant.numeric', [t.number, t.integer, t.float]],
  ['constant.language', [t.bool, t.null, t.atom]],
  ['constant.other', [t.constant(t.variableName)]],
  ['keyword.other.unit', [t.unit]],

  // Keywords
  ['keyword', [t.keyword]],
  ['keyword.control', [t.controlKeyword]],
  ['keyword.operator', [t.operator, t.arithmeticOperator, t.logicOperator, t.compareOperator, t.updateOperator, t.derefOperator]],
  ['keyword.operator.new', [t.operatorKeyword]],
  ['keyword.other.import', [t.moduleKeyword]],
  ['storage.type', [t.definitionKeyword]],
  ['storage.modifier', [t.modifier]],

  // Funciones
  ['entity.name.function', [t.function(t.variableName), t.function(t.propertyName)]],
  ['support.function', [t.standard(t.variableName)]],
  ['entity.name.function.macro', [t.macroName]],

  // Tipos y clases
  ['entity.name.type', [t.typeName]],
  ['entity.name.class', [t.className]],
  ['entity.name.namespace', [t.namespace]],
  ['support.type', [t.typeName]],
  ['support.class', [t.className]],
  ['entity.other.inherited-class', [t.className]],
  ['meta.annotation', [t.annotation]],
  ['storage.type.annotation', [t.annotation]],

  // Variables y propiedades
  ['variable', [t.variableName]],
  ['variable.other.definition', [t.definition(t.variableName)]],
  ['variable.parameter', [t.local(t.variableName)]],
  ['variable.language', [t.self]],
  ['variable.other.constant', [t.constant(t.variableName)]],
  ['variable.other.property', [t.propertyName]],
  ['variable.other.object.property', [t.propertyName]],
  ['support.variable', [t.special(t.variableName)]],
  ['entity.name.label', [t.labelName]],

  // Markup / HTML / XML
  ['entity.name.tag', [t.tagName]],
  ['entity.other.attribute-name', [t.attributeName]],
  ['string.unquoted.attribute-value', [t.attributeValue]],
  ['markup.heading', [t.heading]],
  ['markup.bold', [t.strong]],
  ['markup.italic', [t.emphasis]],
  ['markup.strikethrough', [t.strikethrough]],
  ['markup.underline.link', [t.link, t.url]],
  ['markup.quote', [t.quote]],
  ['markup.inline.raw', [t.monospace]],
  ['markup.inserted', [t.inserted]],
  ['markup.deleted', [t.deleted]],
  ['markup.changed', [t.changed]],
  ['markup.list', [t.list]],

  // Puntuación y meta
  ['punctuation', [t.punctuation, t.separator]],
  ['punctuation.section', [t.bracket]],
  ['punctuation.definition.tag', [t.angleBracket]],
  ['meta.preprocessor', [t.processingInstruction]],
  ['meta.embedded', [t.meta]],

  ['invalid', [t.invalid]],
];
