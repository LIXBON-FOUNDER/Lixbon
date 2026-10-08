package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"lixbon.com/cli/internal/textutil"
)

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0
	case string:
		return x != ""
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	}
	return true
}

// pyStr replica str(valor) para valores JSON (nil se trata como vacío).
func pyStr(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "True"
		}
		return "False"
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	raw, _ := json.Marshal(v)
	return string(raw)
}

func stringArg(args map[string]any, key string) string { return pyStr(args[key]) }

func intArg(args map[string]any, key string) int {
	switch x := args[key].(type) {
	case float64:
		return int(x)
	case int:
		return x
	case string:
		n, _ := strconv.Atoi(strings.TrimSpace(x))
		return n
	}
	return 0
}

func orQuestion(args map[string]any, key string) string {
	if v, ok := args[key]; ok && v != nil {
		return pyStr(v)
	}
	return "?"
}

// ArgsSummary es el resumen compacto de los argumentos de una herramienta,
// para etiquetas de acción y peticiones de aprobación.
func ArgsSummary(tool string, args map[string]any) string {
	switch tool {
	case "run_command":
		prefix := ""
		if truthy(args["background"]) {
			prefix = "(fondo) "
		}
		return prefix + textutil.Head(stringArg(args, "command"), 200)
	case "read_output", "stop_command":
		return stringArg(args, "id")
	case "ask_user":
		return textutil.Head(stringArg(args, "question"), 200)
	case "rename_file":
		return fmt.Sprintf("%s → %s", orQuestion(args, "src"), orQuestion(args, "dst"))
	case "search":
		where := "."
		if truthy(args["path"]) {
			where = pyStr(args["path"])
		}
		return fmt.Sprintf("«%s» en %s", stringArg(args, "pattern"), where)
	case "web_search":
		return fmt.Sprintf("«%s»", stringArg(args, "query"))
	case "fetch_url":
		return textutil.Head(stringArg(args, "url"), 200)
	case "edit_file":
		return fmt.Sprintf("%s (reemplaza %d chars)", orQuestion(args, "path"), utf8.RuneCountInString(stringArg(args, "old_text")))
	case "multi_edit":
		return fmt.Sprintf("%s (%d ediciones)", orQuestion(args, "path"), collectionLen(args["edits"]))
	case "insert_at_line":
		return fmt.Sprintf("%s (inserta en la línea %s)", orQuestion(args, "path"), orQuestion(args, "line"))
	case "write_file", "append_file":
		return fmt.Sprintf("%s (%d chars)", orQuestion(args, "path"), utf8.RuneCountInString(stringArg(args, "content")))
	}
	switch {
	case truthy(args["path"]):
		return textutil.Head(pyStr(args["path"]), 200)
	case truthy(args["pattern"]):
		return textutil.Head(pyStr(args["pattern"]), 200)
	}
	raw, _ := json.Marshal(args)
	return textutil.Head(string(raw), 200)
}

func collectionLen(v any) int {
	switch x := v.(type) {
	case []any:
		return len(x)
	case string:
		return utf8.RuneCountInString(x)
	case map[string]any:
		return len(x)
	}
	return 0
}

var resultPrefix = regexp.MustCompile(`^Archivo (?:editado|creado|sobrescrito|actualizado): \S+ \((.*)\)$`)

// ResultSummary es lo que de verdad dice un resultado: `Archivo editado: x
// (1 reemplazo)` → `1 reemplazo`. La ruta ya va en la línea de la acción.
func ResultSummary(result string) string {
	first, _, _ := strings.Cut(result, "\n")
	first = textutil.Strip(first)
	if m := resultPrefix.FindStringSubmatch(first); m != nil {
		first = m[1]
	}
	return textutil.Head(first, 120)
}

// CallSignature es la huella de una llamada para detectar que el modelo se
// repite: un hash del JSON canónico (las claves de un mapa salen ordenadas).
func CallSignature(tool string, args map[string]any) string {
	raw, _ := json.Marshal(map[string]any{"t": tool, "a": args})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
