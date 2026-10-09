// Package workspace carga lo que cada carpeta de trabajo aporta al agente: el
// contexto permanente del proyecto (LIXBON.md) y los comandos propios del
// usuario. Contrato fijado por validation/fixtures/state_corpus.json.
package workspace

import (
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"lixbon.com/cli/internal/textutil"
)

const (
	maxProjectContextChars = 12000
	customCommandsDir      = "commands"
	maxCommandDescription  = 80
)

// ProjectContext devuelve el LIXBON.md (o lixbon.md) del workspace recortado a
// 12.000 caracteres, o "" si no hay o está vacío. Es el equivalente al
// CLAUDE.md de otros CLI: viaja con cada turno para que el modelo no tenga
// que redescubrir el stack y las convenciones.
func ProjectContext(root string) string {
	for _, name := range []string{"LIXBON.md", "lixbon.md"} {
		path := filepath.Join(root, name)
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return ""
		}
		return textutil.Head(textutil.Strip(textutil.DecodeLossy(data)), maxProjectContextChars)
	}
	return ""
}

// Command es un comando propio: el archivo .md es el prompt.
type Command struct {
	Name        string
	Description string
	Body        string
	Path        string
}

// LoadCommands lee los .md de <homeDir>/commands y de
// <workspace>/.lixbon/commands; los del proyecto pisan a los del usuario.
// reserved son los nombres de los comandos del CLI, que nunca se pisan. La
// primera línea «# título» es la descripción.
func LoadCommands(workspace, homeDir string, reserved []string) map[string]Command {
	found := map[string]Command{}
	for _, base := range []string{
		filepath.Join(homeDir, customCommandsDir),
		filepath.Join(workspace, ".lixbon", customCommandsDir),
	} {
		entries, err := os.ReadDir(base)
		if err != nil {
			continue
		}
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".md") {
				names = append(names, e.Name())
			}
		}
		sort.Strings(names)
		for _, file := range names {
			name := commandName(strings.TrimSuffix(file, ".md"))
			if name == "" || slices.Contains(reserved, name) {
				continue
			}
			data, err := os.ReadFile(filepath.Join(base, file))
			if err != nil {
				continue
			}
			text := textutil.DecodeLossy(data)
			lines := textutil.SplitLines(textutil.Strip(text))
			cmd := Command{Name: name, Path: filepath.Join(base, file)}
			if len(lines) > 0 && strings.HasPrefix(lines[0], "#") {
				cmd.Description = textutil.Head(textutil.Strip(strings.TrimLeft(lines[0], "# ")), maxCommandDescription)
				cmd.Body = textutil.Strip(strings.Join(lines[1:], "\n"))
			} else {
				cmd.Description = "prompt de " + file
				cmd.Body = textutil.Strip(text)
			}
			found[name] = cmd
		}
	}
	return found
}

// commandName normaliza el nombre de archivo: minúsculas, y cada carácter que
// no sea a-z, 0-9 o «-» pasa a ser «-».
func commandName(stem string) string {
	var sb strings.Builder
	for _, r := range strings.ToLower(stem) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			sb.WriteRune(r)
		} else {
			sb.WriteByte('-')
		}
	}
	return strings.Trim(sb.String(), "-")
}

// Expand sustituye $ARGUMENTS por lo que siga al comando; sin marcador, los
// argumentos se añaden al final.
func Expand(body, arguments string) string {
	arguments = textutil.Strip(arguments)
	if strings.Contains(body, "$ARGUMENTS") {
		return strings.ReplaceAll(body, "$ARGUMENTS", arguments)
	}
	if arguments != "" {
		return textutil.Strip(body + "\n\n" + arguments)
	}
	return body
}
