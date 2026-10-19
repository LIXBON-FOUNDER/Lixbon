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

var Groups = []string{"conversation", "agent", "account", "system"}

// NameWidth alinea los argumentos y las descripciones en /help y en el menú.
const NameWidth = 10

// Los comandos van en inglés (nombre, argumentos, grupo y descripción); el
// resto de la interfaz sigue en español.
var Specs = []Spec{
	{"help", "", "Show all commands", "conversation"},
	{"model", "[name]", "Switch model (no argument opens the picker)", "conversation"},
	{"mode", "[ask|agent|delegate]", "Change the working mode", "conversation"},
	{"new", "", "Start a new conversation", "conversation"},
	{"compact", "", "Compact the conversation to free up context", "conversation"},
	{"history", "[messages]", "Browse and reopen past conversations", "conversation"},
	{"image", "<path>", "Add an image to the message (also @path)", "conversation"},
	{"paste", "", "Paste the clipboard image into the message (Alt+V)", "conversation"},
	{"web", "[auto|on|off]", "Web search: the model decides, always or never", "conversation"},
	{"copy", "", "Copy the last reply to the clipboard", "conversation"},
	{"save", "[path]", "Save the conversation as a Markdown file", "conversation"},
	{"clear", "", "Clear the context and start fresh", "conversation"},
	{"approve", "[on|off]", "Auto-approve the agent's tools", "agent"},
	{"plan", "[on|off]", "Plan mode: the agent explores and proposes, touching nothing", "agent"},
	{"todo", "", "Show the agent's step list", "agent"},
	{"tools", "", "Show the tools the agent can use", "agent"},
	{"diff", "[path]", "Show the workspace's uncommitted changes", "agent"},
	{"undo", "", "Revert the files the agent's last turn touched", "agent"},
	{"ps", "", "The agent's background commands (and stop them)", "agent"},
	{"check", "[on|off]", "Lint every file the agent edits", "agent"},
	{"allow", "[command]", "Commands the agent runs without asking (npm test, pytest…)", "agent"},
	{"commit", "[message]", "Commit the changes with a message written by the model", "agent"},
	{"mcp", "", "MCP servers: see their tools or add one", "agent"},
	{"browser", "[on|off|auto|close|open <url>]", "The agent's browser: status, enable, close or open to sign in", "agent"},
	{"run", "<command>", "Run a command and give its output to the model", "agent"},
	{"workspace", "[path]", "Working folder for agent mode", "agent"},
	{"init", "", "Generate LIXBON.md with the project's context", "agent"},
	{"visual", "<what to design> | <id> <change> | code <id> [stack]", "Design in Lixbon Visuals: create, edit or turn into code", "agent"},
	{"status", "", "Show the session status", "account"},
	{"cost", "", "Tokens and context used in this session", "account"},
	{"usage", "", "Show the account's overall usage", "account"},
	{"nodes", "", "Show the cluster nodes", "account"},
	{"login", "", "Sign in again", "account"},
	{"logout", "", "Sign out on this machine", "account"},
	{"key", "<api_key>", "Use another API key", "account"},
	{"config", "", "CLI settings in a menu", "system"},
	{"bar", "[on|off]", "Status bar pinned to the bottom of the terminal", "system"},
	{"doctor", "", "Diagnose the terminal, connection and session", "system"},
	{"remote", "", "Control this session from the mobile app (link + QR)", "system"},
	{"update", "", "Update the CLI from the server", "system"},
	{"exit", "", "Quit", "system"},
}

// GoSpecs son comandos que solo existen en el CLI Go. Quedan fuera de Specs
// porque este es el contrato con el catálogo de Python.
var GoSpecs = []Spec{
	{"provider", "[name | key name]", "Switch model provider or one's key (lixbon.com, LM Studio, Ollama…)", "account"},
	{"orchestrate", "<goal>", "The agent coordinates a team of agents in Lixbon Desktop", "agent"},
	{"orchestrator", "", "Lixbon Desktop orchestrator status: runs and tasks", "agent"},
	{"effort", "[auto|off|low|medium|high]", "How much the model reasons before answering", "conversation"},
	{"branch", "[branch]", "List the repository's branches and switch between them", "agent"},
}

// aliases son los nombres en español de antes: siguen funcionando, pero no
// salen en el menú ni en /help.
var aliases = map[string]string{"orquestar": "orchestrate", "orquestador": "orchestrator"}

// canonical devuelve el nombre en inglés de un comando escrito con su alias.
func canonical(name string) string {
	if real, ok := aliases[name]; ok {
		return real
	}
	return name
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
	name = canonical(name)
	for _, s := range slices.Concat(Specs, GoSpecs) {
		if s.Name == name {
			return s, true
		}
	}
	return Spec{}, false
}

// spec busca un comando que exista ahora mismo para esta sesión.
func (m *Model) spec(name string) (Spec, bool) {
	if !m.available(name) {
		return Spec{}, false
	}
	return lookup(name)
}

// available: /key cambia la API key de una sesión iniciada con clave; con la
// cuenta de lixbon.com (login por navegador) no hay clave que cambiar.
func (m *Model) available(name string) bool {
	if name == "key" {
		return m.chat.Client.Generic || m.chat.Cfg.APIKey != "" && m.chat.Cfg.ExtraString("account_email") == ""
	}
	return true
}
