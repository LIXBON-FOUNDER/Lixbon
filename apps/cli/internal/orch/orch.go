// Package orch conecta el CLI con el orquestador de Lixbon Desktop: encuentra
// `lxo`, comprueba que el host responde y da al agente las instrucciones para
// coordinar. El estado vive en el desktop; aquí no se guarda nada.
package orch

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	discoveryFile = "orch.json"
	envLxo        = "LXO_BIN"
	dialTimeout   = 250 * time.Millisecond
)

const (
	problemClosed = "Lixbon Desktop no está abierto o el orquestador está desactivado (Ajustes → Orquestador)."
	problemStale  = "Lixbon Desktop dejó de responder: ábrelo de nuevo."
	problemNoLxo  = "No se encontró lxo. Viaja junto al ejecutable de Lixbon Desktop; si lo moviste, apunta la variable LXO_BIN a su ruta."
)

type Info struct {
	Lxo     string
	Running bool
	Problem string
}

func (i Info) Available() bool { return i.Lxo != "" && i.Running }

type discovery struct {
	Port int    `json:"port"`
	Lxo  string `json:"lxo"`
}

var dialPort = func(port int) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), dialTimeout)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func Discover(dir string) Info {
	var d discovery
	raw, readErr := os.ReadFile(filepath.Join(dir, discoveryFile))
	hasFile := readErr == nil && json.Unmarshal(raw, &d) == nil && d.Port > 0
	info := Info{Lxo: findLxo(d.Lxo)}
	switch {
	case !hasFile:
		info.Problem = problemClosed
	case !dialPort(d.Port):
		info.Problem = problemStale
	default:
		info.Running = true
	}
	if info.Lxo == "" && info.Problem == "" {
		info.Problem = problemNoLxo
	}
	return info
}

func findLxo(published string) string {
	for _, candidate := range []string{os.Getenv(envLxo), published} {
		if candidate != "" && fileExists(candidate) {
			return candidate
		}
	}
	if path, err := exec.LookPath("lxo"); err == nil {
		return path
	}
	return ""
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

var chaining = regexp.MustCompile("[&|;<>`\r\n]|\\$\\(")

// IsLxoCommand dice si el comando es una llamada suelta a lxo. Encadenar con
// otra orden la deja fuera: solo el propio orquestador se salta la pregunta.
func (i Info) IsLxoCommand(command string) bool {
	if i.Lxo == "" {
		return false
	}
	command = strings.TrimSpace(command)
	if chaining.MatchString(command) {
		return false
	}
	lower, path := strings.ToLower(command), strings.ToLower(i.Lxo)
	return strings.HasPrefix(lower, `"`+path+`" `) || strings.HasPrefix(lower, path+" ") || strings.HasPrefix(lower, "lxo ")
}

// PromptSection es la parte del system prompt que convierte al agente en
// coordinador cuando el usuario pide /orquestar.
func PromptSection(i Info) string {
	lxo := `"` + i.Lxo + `"`
	return "\n\n## Orquestador de agentes (Lixbon)\n" +
		`Cuando el usuario escriba "/orquestar <objetivo>" (o te pida orquestar o coordinar agentes), eres el COORDINADOR: ` +
		"no implementas, repartes el objetivo entre agentes hijos lanzándolos por rol (lxo roles, lxo spawn --role …), " +
		"esperas sus informes y le cuentas el resultado. Cada lanzamiento y cada integración las aprueba una persona en " +
		"Lixbon Desktop: no intentes saltarte esa aprobación ni repetir un lanzamiento que sigue pendiente.\n" +
		"Usa la CLI " + lxo + " con run_command (siempre esa ruta entre comillas en lugar de lxo), una orden por llamada " +
		"y sin encadenar con ;, && ni |. Antes de nada ejecuta " + lxo + " guide coordinator y síguela. " +
		"Para " + lxo + " wait usa timeout 600 en run_command y --timeout-ms 540000."
}
