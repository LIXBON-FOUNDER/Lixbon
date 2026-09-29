// agentSchemas.js — definiciones de funciones (formato OpenAI) para tool-calling
// NATIVO. El gateway las pasa a Ollama; los modelos que soportan tools (qwen2.5,
// llama3.2…) devuelven tool_calls estructurados en vez de JSON dentro del texto.
// Es opt-in (Ajustes → Herramientas nativas): si el modelo no soporta tools o
// falla, se usa el protocolo de texto de siempre.

const p = (type, description, extra = {}) => ({ type, description, ...extra });

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Lista los archivos del workspace (o de una subcarpeta).',
      parameters: {
        type: 'object',
        properties: { path: p('string', 'Ruta relativa; "." para la raíz') },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: "Busca archivos por nombre con un patrón glob: '*.py', 'test_*', 'src/**/*.jsx'.",
      parameters: {
        type: 'object',
        properties: { pattern: p('string', 'Patrón glob del nombre o de la ruta relativa') },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'outline',
      description: 'Esqueleto de un archivo: funciones, clases y encabezados con su línea. Úsalo antes de read_file en archivos grandes.',
      parameters: {
        type: 'object',
        properties: { path: p('string', 'Ruta relativa del archivo') },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Lee el contenido de un archivo. Admite rango de líneas.',
      parameters: {
        type: 'object',
        properties: {
          path: p('string', 'Ruta relativa del archivo'),
          start_line: p('integer', 'Primera línea (1-based), opcional'),
          end_line: p('integer', 'Última línea, opcional'),
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Reemplaza un fragmento EXACTO de un archivo (edición parcial). Preferir sobre write_file para editar.',
      parameters: {
        type: 'object',
        properties: {
          path: p('string', 'Ruta relativa del archivo'),
          old_text: p('string', 'Fragmento actual a reemplazar, copiado EXACTO (con su indentación)'),
          new_text: p('string', 'Texto nuevo'),
          all: p('boolean', 'Reemplazar todas las apariciones (por defecto solo la primera)'),
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'multi_edit',
      description: 'Varias sustituciones EXACTAS en un mismo archivo, en orden. Preferir a varios edit_file seguidos.',
      parameters: {
        type: 'object',
        properties: {
          path: p('string', 'Ruta relativa del archivo'),
          edits: {
            type: 'array',
            description: 'Sustituciones en orden',
            items: {
              type: 'object',
              properties: {
                old_text: p('string', 'Fragmento actual, copiado exacto'),
                new_text: p('string', 'Texto nuevo'),
              },
              required: ['old_text', 'new_text'],
            },
          },
        },
        required: ['path', 'edits'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'insert_at_line',
      description: 'Inserta texto ANTES de la línea indicada (1-based). line=0 o mayor que el total: al final.',
      parameters: {
        type: 'object',
        properties: {
          path: p('string', 'Ruta relativa del archivo'),
          line: p('integer', 'Número de línea delante de la cual insertar'),
          content: p('string', 'Texto a insertar (con sus saltos de línea)'),
        },
        required: ['path', 'line', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Crea o sobrescribe un archivo con el contenido completo. Usar para archivos nuevos o reescrituras totales.',
      parameters: {
        type: 'object',
        properties: {
          path: p('string', 'Ruta relativa del archivo'),
          content: p('string', 'Contenido completo del archivo'),
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_file',
      description: 'Añade texto al final de un archivo (lo crea si no existe).',
      parameters: {
        type: 'object',
        properties: {
          path: p('string', 'Ruta relativa del archivo'),
          content: p('string', 'Texto a añadir'),
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mkdir',
      description: 'Crea una carpeta (y las intermedias si faltan).',
      parameters: {
        type: 'object',
        properties: { path: p('string', 'Ruta relativa de la carpeta') },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search',
      description: 'Busca un texto EXACTO en los archivos del workspace (grep).',
      parameters: {
        type: 'object',
        properties: { pattern: p('string', 'Texto a buscar') },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_codebase',
      description: 'Búsqueda SEMÁNTICA en el índice del codebase: encuentra fragmentos relevantes por significado (no por texto exacto). Útil para "dónde se hace X".',
      parameters: {
        type: 'object',
        properties: { query: p('string', 'Qué buscar, en lenguaje natural') },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Elimina un archivo o carpeta.',
      parameters: {
        type: 'object',
        properties: { path: p('string', 'Ruta relativa') },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rename_file',
      description: 'Mueve o renombra un archivo.',
      parameters: {
        type: 'object',
        properties: {
          src: p('string', 'Ruta origen'),
          dst: p('string', 'Ruta destino'),
        },
        required: ['src', 'dst'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Ejecuta un comando de shell en el workspace (tests, build, instalar dependencias).',
      parameters: {
        type: 'object',
        properties: {
          command: p('string', 'Comando a ejecutar'),
          timeout: p('integer', 'Segundos máximos (por defecto 30)'),
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Descarga una página web y devuelve su texto (el HTML se limpia de etiquetas).',
      parameters: {
        type: 'object',
        properties: { url: p('string', 'URL http(s) a descargar') },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Busca en internet vía el gateway (mismos proveedores que la búsqueda web del chat).',
      parameters: {
        type: 'object',
        properties: {
          query: p('string', 'Qué buscar'),
          limit: p('integer', 'Máximo de resultados (por defecto 5)'),
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Pregunta al usuario con opciones para elegir (hasta 4 preguntas). Úsala solo cuando una decisión dependa de él y no se pueda deducir del código. Siempre podrá escribir otra respuesta.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: '1 a 4 preguntas',
            items: {
              type: 'object',
              properties: {
                question: p('string', 'La pregunta, completa y clara'),
                header: p('string', 'Etiqueta corta (máx. 24 caracteres)'),
                multiSelect: p('boolean', 'true si puede elegir varias opciones'),
                options: {
                  type: 'array',
                  description: '2 a 6 opciones',
                  items: {
                    type: 'object',
                    properties: { label: p('string', 'Texto de la opción'), description: p('string', 'Qué implica elegirla') },
                    required: ['label'],
                  },
                },
              },
              required: ['question', 'options'],
            },
          },
        },
        required: ['questions'],
      },
    },
  },
];

/** Convierte un tool_call nativo (OpenAI) al formato interno {tool, args}. */
export function nativeCallToInternal(call) {
  const fn = call.function || {};
  let args = fn.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  return { tool: fn.name, args: args && typeof args === 'object' ? args : {} };
}
