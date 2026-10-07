package tui

import (
	"slices"
	"strings"
)

// Spec es un comando «/». El catálogo replica el del CLI Python
// (validation/fixtures/state_corpus.json, sección catalog).
type Spec struct {
	Name  string
	Args  string
	Desc  string
	Group string
}

var Groups = []string{"conversación", "agente", "cuenta", "sistema"}

// NameWidth alinea los argumentos y las descripciones en /help y en el menú.
const NameWidth = 15

var Specs = []Spec{
	{"help", "", "Ver todos los comandos", "conversación"},
	{"model", "[nombre]", "Cambiar de modelo (sin argumento abre el selector)", "conversación"},
	{"mode", "[ask|agent|delegate]", "Cambiar modo de trabajo", "conversación"},
	{"new", "", "Empezar una conversación nueva", "conversación"},
	{"compact", "", "Compactar la conversación para liberar contexto", "conversación"},
	{"history", "[mensajes]", "Ver y reabrir conversaciones anteriores", "conversación"},
	{"image", "<ruta>", "Escribir una imagen en el mensaje (también @ruta)", "conversación"},
	{"paste", "", "Escribir la imagen del portapapeles en el mensaje (Alt+V)", "conversación"},
	{"web", "[auto|on|off]", "Búsqueda web: el modelo decide, siempre o nunca", "conversación"},
	{"copy", "", "Copiar la última respuesta al portapapeles", "conversación"},
	{"save", "[ruta]", "Guardar la conversación en un archivo Markdown", "conversación"},
	{"clear", "", "Vaciar el contexto y empezar de cero", "conversación"},
	{"approve", "[on|off]", "Auto-aprobar herramientas del agente", "agente"},
	{"plan", "[on|off]", "Modo plan: el agente solo explora y propone, sin tocar nada", "agente"},
	{"todo", "", "Ver la lista de pasos del agente", "agente"},
	{"tools", "", "Ver las herramientas que puede usar el agente", "agente"},
	{"diff", "[ruta]", "Ver los cambios sin confirmar del workspace", "agente"},
	{"undo", "", "Revertir los archivos que tocó el último turno del agente", "agente"},
	{"ps", "", "Comandos en segundo plano del agente (y pararlos)", "agente"},
	{"check", "[on|off]", "Verificar con el linter cada archivo que edita el agente", "agente"},
	{"allow", "[comando]", "Comandos que el agente ejecuta sin preguntar (npm test, pytest…)", "agente"},
	{"commit", "[mensaje]", "Commit de los cambios con mensaje redactado por el modelo", "agente"},
	{"mcp", "", "Servidores MCP conectados y sus herramientas", "agente"},
	{"run", "<comando>", "Ejecutar un comando y darle la salida al modelo", "agente"},
	{"workspace", "[ruta]", "Carpeta de trabajo del modo agent", "agente"},
	{"init", "", "Generar LIXBON.md con el contexto del proyecto", "agente"},
	{"visual", "<qué diseñar> | <id> <cambio> | codigo <id> [stack]", "Diseñar en Lixbon Visuals: crear, editar o pasar a código", "agente"},
	{"status", "", "Ver estado de la sesión", "cuenta"},
	{"cost", "", "Tokens y contexto consumidos en esta sesión", "cuenta"},
	{"usage", "", "Ver uso global de la cuenta", "cuenta"},
	{"nodes", "", "Ver nodos del clúster", "cuenta"},
	{"login", "", "Iniciar sesión de nuevo", "cuenta"},
	{"logout", "", "Cerrar la sesión de esta máquina", "cuenta"},
	{"key", "<api_key>", "Usar otra API key", "cuenta"},
	{"config", "", "Ajustes del CLI en un menú", "sistema"},
	{"context-window", "<n>", "Tokens de la ventana de contexto (para la barra)", "sistema"},
	{"bar", "[on|off]", "Barra de estado fija al pie de la terminal", "sistema"},
	{"doctor", "", "Diagnóstico de terminal, conexión y sesión", "sistema"},
	{"remote", "", "Controlar esta sesión desde la app móvil (link + QR)", "sistema"},
	{"update", "", "Actualizar el CLI desde el servidor", "sistema"},
	{"exit", "", "Salir", "sistema"},
}

// GoSpecs son comandos que solo existen en el CLI Go. Quedan fuera de Specs
// porque este es el contrato con el catálogo de Python.
var GoSpecs = []Spec{
	{"provider", "[nombre]", "Cambiar de proveedor de modelos (lixbon.com, LM Studio, Ollama…)", "cuenta"},
	{"mouse", "", "Activar o quitar la rueda del ratón (activa, el terminal no deja seleccionar texto)", "conversación"},
}

// Ordered devuelve el catálogo por grupo (en el orden de Groups) y, dentro,
// alfabético: es el orden del menú y de /help.
func Ordered() []Spec { return order(Specs) }

func order(specs []Spec) []Spec {
	out := slices.Clone(specs)
	slices.SortStableFunc(out, func(a, b Spec) int {
		ga, gb := slices.Index(Groups, a.Group), slices.Index(Groups, b.Group)
		if ga < 0 {
			ga = 99
		}
		if gb < 0 {
			gb = 99
		}
		if ga != gb {
			return ga - gb
		}
		return strings.Compare(a.Name, b.Name)
	})
	return out
}

// Match devuelve los comandos cuyo nombre empieza por prefix (sin la barra),
// en el orden del menú.
func Match(prefix string) []Spec {
	prefix = strings.ToLower(prefix)
	var out []Spec
	for _, s := range Ordered() {
		if strings.HasPrefix(s.Name, prefix) {
			out = append(out, s)
		}
	}
	return out
}

func lookup(name string) (Spec, bool) {
	for _, s := range slices.Concat(Specs, GoSpecs) {
		if s.Name == name {
			return s, true
		}
	}
	return Spec{}, false
}
