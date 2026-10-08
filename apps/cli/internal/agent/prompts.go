package agent

import (
	"encoding/json"
	"fmt"
	"strings"

	"lixbon.com/cli/internal/history"
	"lixbon.com/cli/internal/textutil"
	"lixbon.com/cli/internal/tools"
)

const (
	MaxSteps         = 40
	MaxRepeatedCalls = 3
)

const fence = "```"

const (
	NudgePrompt = "Si ese código debía aplicarse a un archivo del workspace, hazlo AHORA con " +
		`{"tool":"write_file","args":{"path":"...","content":"CONTENIDO COMPLETO"}} ` +
		"(JSON puro, sin " + fence + `). Si no había nada que aplicar, responde solo "OK".`

	NativeNudgePrompt = "No escribas el código en el chat: aplícalo AHORA llamando a la herramienta " +
		"write_file (o edit_file si el archivo ya existe), y usa run_command para los " +
		`comandos. Si no había nada que aplicar, responde solo "OK".`

	NoOutputPrompt = "Has razonado pero no has emitido ninguna respuesta ni ninguna llamada a " +
		"herramienta. NO vuelvas a razonar: ejecuta AHORA el siguiente paso llamando " +
		"a la herramienta que toque, o responde con el resumen final si ya no queda " +
		"nada por hacer."

	TruncatedPrompt = "Tu respuesta anterior se CORTÓ a mitad porque el contenido era demasiado largo. " +
		"NO reescribas el archivo entero con write_file. Usa edit_file para cambiar solo las " +
		"secciones necesarias (old_text/new_text), en varios pasos pequeños si hace falta."

	PlanModePrompt = "\n\n=== MODO PLAN ===\n" +
		"Estás en modo plan: SOLO puedes leer, buscar y preguntar. No escribas, edites ni borres archivos " +
		"ni ejecutes comandos. Explora lo necesario y termina con un plan numerado, concreto (archivos y " +
		"cambios), para que el usuario lo apruebe. Cuando lo apruebe y salga del modo plan, ejecútalo."

	TodoPrompt = "\n\nPara peticiones con varios pasos, empieza llamando a `todo` con la lista de pasos y " +
		"actualízala al completar cada uno. Si algo es ambiguo y cambia el resultado, usa `ask_user` " +
		"antes de tocar archivos."

	ToolImagesPrompt = "Imágenes de los read_file anteriores, en el mismo orden. Continúa."
)

// NativeSystemPrompt es el prompt para tool-calling nativo: las herramientas
// ya van en el template del modelo, así que solo se dan las reglas de uso.
func NativeSystemPrompt(workspace string) string {
	return "Eres un agente de código que trabaja DIRECTAMENTE sobre los archivos del usuario " +
		"llamando a las herramientas que tienes disponibles.\n" +
		"Workspace: " + workspace + "\n" +
		"Las rutas son siempre RELATIVAS al workspace.\n\n" +
		"=== REGLAS ===\n" +
		"1. Si el usuario pide crear, inicializar, modificar, arreglar, eliminar o ejecutar algo, " +
		"LLAMA A LAS HERRAMIENTAS. Tú aplicas los cambios: el usuario no copia código a mano.\n" +
		"2. NUNCA respondas con el código en un bloque " + fence + " cuando lo que toca es escribirlo en " +
		"un archivo: eso va en el argumento content de write_file.\n" +
		"3. Para crear un proyecto: mkdir/write_file para los archivos, y run_command para los " +
		"comandos de scaffolding, instalación o git.\n" +
		"4. Para modificar un archivo que ya existe: primero read_file, luego edit_file con el " +
		"fragmento exacto. write_file solo para archivos nuevos o reescrituras completas.\n" +
		"5. Puedes llamar a varias herramientas seguidas; el resultado de cada una te llega antes " +
		"del siguiente paso. Nunca inventes el resultado de una herramienta.\n" +
		"6. Tras cambiar código, si hay tests o build, verifícalo con run_command y corrige si el " +
		"EXIT es distinto de 0.\n" +
		"7. Cuando ya no quede nada que hacer, responde con texto normal resumiendo lo hecho.\n\n" +
		// Los modelos chicos conocen el formato pero se saltan los tags
		// <tool_call>; repetirlo hace que el JSON salga bien formado y el CLI
		// lo parsee igual desde el texto.
		"=== FORMATO DE LLAMADA ===\n" +
		"Cada llamada va EXACTAMENTE así, sin " + fence + " alrededor:\n" +
		"<tool_call>\n" +
		`{"name": "write_file", "arguments": {"path": "…", "content": "…"}}` + "\n" +
		"</tool_call>\n\n" +
		"=== ARCHIVOS DEL WORKSPACE ===\n" +
		tools.WorkspaceTree(workspace, tools.MaxTreeEntries)
}

// TextSystemPrompt es el prompt del protocolo de texto: describe cada
// herramienta con un JSON de ejemplo.
func TextSystemPrompt(workspace string) string {
	return "Eres un agente de código experto que trabaja DIRECTAMENTE sobre los archivos del usuario.\n" +
		"Workspace: " + workspace + "\n" +
		"Rutas siempre RELATIVAS al workspace.\n\n" +
		"=== HERRAMIENTAS DISPONIBLES ===\n" +
		"Para usar una herramienta escribe una línea que contenga SOLO su JSON:\n" +
		`{"tool":"list_files","args":{"path":".","recursive":false}}` + "\n" +
		`{"tool":"find_files","args":{"pattern":"*.py"}}` + "\n" +
		`{"tool":"outline","args":{"path":"src/app.py"}}  (funciones y clases con su línea, para leer solo un rango)` + "\n" +
		`{"tool":"read_file","args":{"path":"archivo.txt"}}  (opcional: "start_line" y "end_line" para archivos grandes; ` +
		"un .pdf o .docx llega como texto y una imagen png/jpg/webp se te adjunta para que la veas)\n" +
		`{"tool":"edit_file","args":{"path":"archivo.txt","old_text":"fragmento EXACTO actual","new_text":"fragmento nuevo"}}` + "\n" +
		`{"tool":"multi_edit","args":{"path":"archivo.txt","edits":[{"old_text":"a","new_text":"b"},{"old_text":"c","new_text":"d"}]}}` + "\n" +
		`{"tool":"insert_at_line","args":{"path":"archivo.txt","line":12,"content":"nueva línea\n"}}` + "\n" +
		`{"tool":"write_file","args":{"path":"archivo.txt","content":"contenido completo"}}` + "\n" +
		`{"tool":"append_file","args":{"path":"archivo.txt","content":"texto nuevo al final"}}` + "\n" +
		`{"tool":"mkdir","args":{"path":"carpeta/subcarpeta"}}` + "\n" +
		`{"tool":"search","args":{"pattern":"texto a buscar","path":".","glob":"*.js","ignore_case":true}}` + "\n" +
		`{"tool":"delete_file","args":{"path":"archivo.txt"}}` + "\n" +
		`{"tool":"rename_file","args":{"src":"viejo.txt","dst":"nuevo.txt"}}` + "\n" +
		`{"tool":"run_command","args":{"command":"npm install","timeout":60}}  (con "background":true devuelve un id; ` +
		`luego {"tool":"read_output","args":{"id":"p1","wait":5}} y {"tool":"stop_command","args":{"id":"p1"}})` + "\n" +
		`{"tool":"web_search","args":{"query":"fastapi lifespan deprecated on_event","limit":5}}` + "\n" +
		`{"tool":"fetch_url","args":{"url":"https://ejemplo.com/docs"}}` + "\n" +
		`{"tool":"todo","args":{"items":[{"text":"leer app.py","status":"done"},{"text":"añadir la ruta","status":"doing"}]}}` + "\n" +
		`{"tool":"ask_user","args":{"question":"¿SQLite o Postgres?","options":["SQLite","Postgres"]}}` + "\n\n" +
		"=== REGLAS OBLIGATORIAS ===\n" +
		"1. Si el usuario pide crear, modificar, arreglar, eliminar o ejecutar algo, DEBES hacerlo " +
		"con herramientas EN ESTA MISMA RESPUESTA. Tú ejecutas los cambios; el usuario no copia código.\n" +
		"2. PROHIBIDO responder a una petición de cambio mostrando código en bloques " + fence + ": " +
		"el código va DENTRO del JSON de edit_file o write_file.\n" +
		"3. Emite el JSON puro de la herramienta, sin envolverlo en markdown.\n" +
		"4. Para EDITAR o MEJORAR un archivo existente: primero read_file, luego edit_file con el fragmento exacto " +
		"(old_text copiado tal cual, con su indentación). NUNCA reescribas un archivo grande entero con write_file: " +
		"la salida se trunca y falla. write_file es SOLO para archivos nuevos. Haz varios edit_file pequeños si el cambio es amplio.\n" +
		"5. Puedes encadenar varias herramientas en una misma respuesta.\n" +
		"6. Los resultados te llegan como TOOL_RESULT. Úsalos para continuar; nunca los escribas tú.\n" +
		"7. Tras cambiar código, si el proyecto tiene tests o build, verifica con run_command; " +
		"si el resultado trae un error (EXIT distinto de 0), CORRIGE el archivo y vuelve a ejecutar hasta que pase.\n" +
		"8. Cuando termines todas las acciones, responde SOLO con texto normal (sin JSON ni código) resumiendo lo que hiciste.\n\n" +
		"=== EJEMPLO 1 (crear) ===\n" +
		"Usuario: crea un script que imprima hola\n" +
		`Asistente: {"tool":"write_file","args":{"path":"hola.py","content":"print('hola')\n"}}` + "\n" +
		"Usuario: TOOL_RESULT write_file: Archivo creado: hola.py (14 chars)\n" +
		"Asistente: Listo: creé hola.py, que imprime «hola» al ejecutarlo.\n\n" +
		"=== EJEMPLO 2 (editar) ===\n" +
		"Usuario: renombra la variable x a total en utils.js\n" +
		`Asistente: {"tool":"read_file","args":{"path":"utils.js"}}` + "\n" +
		`Usuario: TOOL_RESULT read_file: export const x = 1;\nexport const y = x + 2;` + "\n" +
		`Asistente: {"tool":"edit_file","args":{"path":"utils.js","old_text":"export const x = 1;\nexport const y = x + 2;","new_text":"export const total = 1;\nexport const y = total + 2;"}}` + "\n" +
		"Usuario: TOOL_RESULT edit_file: Archivo editado: utils.js (1 reemplazo)\n" +
		"Asistente: Hecho: renombré x a total en utils.js.\n\n" +
		"=== ARCHIVOS DEL WORKSPACE ===\n" +
		tools.WorkspaceTree(workspace, tools.MaxTreeEntries) + "\n\n" +
		"=== RECUERDA ===\n" +
		"Las peticiones de cambio se resuelven con herramientas, nunca mostrando código en el chat."
}

// MCPTextPrompt describe las herramientas MCP para el protocolo de texto:
// nombre, argumentos (en el orden del servidor) y descripción.
func MCPTextPrompt(schemas []json.RawMessage) string {
	lines := []string{"\n\n=== HERRAMIENTAS EXTERNAS (MCP) ==="}
	for _, raw := range schemas[:min(len(schemas), 40)] {
		var schema struct {
			Function struct {
				Name        string          `json:"name"`
				Description string          `json:"description"`
				Parameters  json.RawMessage `json:"parameters"`
			} `json:"function"`
		}
		if json.Unmarshal(raw, &schema) != nil {
			continue
		}
		keys := propertyKeys(schema.Function.Parameters)
		args := make([]string, 0, 8)
		for _, k := range keys[:min(len(keys), 8)] {
			args = append(args, fmt.Sprintf(`"%s":…`, k))
		}
		lines = append(lines, fmt.Sprintf(`{"tool":"%s","args":{%s}}  %s`,
			schema.Function.Name, strings.Join(args, ", "), textutil.Head(schema.Function.Description, 120)))
	}
	return strings.Join(lines, "\n")
}

// propertyKeys devuelve las claves de parameters.properties en el orden en que
// el servidor las declaró.
func propertyKeys(parameters json.RawMessage) []string {
	var outer map[string]json.RawMessage
	if json.Unmarshal(parameters, &outer) != nil {
		return nil
	}
	dec := json.NewDecoder(strings.NewReader(string(outer["properties"])))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil
	}
	var keys []string
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		keys = append(keys, tok.(string))
		var skip json.RawMessage
		if dec.Decode(&skip) != nil {
			break
		}
	}
	return keys
}

// SanitizeForPlainChat quita el round-trip de tools del historial: un
// role="tool" solo es válido justo detrás del assistant que lo pidió.
func SanitizeForPlainChat(messages []history.Message) []history.Message {
	out := []history.Message{}
	for _, m := range messages {
		if m.Role == "tool" {
			continue
		}
		if len(m.ToolCalls) > 0 {
			m.ToolCalls = nil
			if textutil.Strip(m.Content) == "" {
				continue
			}
		}
		out = append(out, m)
	}
	return out
}
