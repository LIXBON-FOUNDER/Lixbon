package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"lixbon.com/cli/internal/textutil"
	"lixbon.com/cli/internal/tools"
)

const (
	checkTimeout  = 20 * time.Second
	maxCheckChars = 2500
	maxCheckBytes = 64 << 10
)

// pySyntaxCheck comprueba la sintaxis sin escribir __pycache__ junto al
// archivo (py_compile lo hacía en el directorio del usuario).
const pySyntaxCheck = `import sys, traceback
try:
    compile(open(sys.argv[1], 'rb').read(), sys.argv[1], 'exec')
except SyntaxError as e:
    sys.stderr.write(''.join(traceback.format_exception_only(type(e), e)))
    sys.exit(1)
`

// VerifyFile pasa el verificador del archivo: devuelve la herramienta usada y
// los errores (vacío = pasó o no hay verificador). Si el verificador no se
// puede ejecutar o agota el tiempo, cuenta como «sin errores»: no se acusa al
// modelo de algo que no se ha comprobado.
func VerifyFile(ctx context.Context, workspace, path string) (tool, errs string) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", ""
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".py":
		tool, errs = checkPython(ctx, workspace, path)
	case ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx":
		tool, errs = checkJS(ctx, workspace, path)
	case ".json":
		tool, errs = checkJSON(path)
	case ".go":
		tool, errs = checkGo(path)
	default:
		return "", ""
	}
	if runes := []rune(errs); len(runes) > maxCheckChars {
		errs = string(runes[:maxCheckChars]) + "\n…[recortado]"
	}
	return tool, errs
}

type limitedBuffer struct {
	bytes.Buffer
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := maxCheckBytes - b.Len(); room > 0 {
		b.Buffer.Write(p[:min(room, len(p))])
	}
	return len(p), nil
}

// runCheck ejecuta un verificador. ran=false si no pudo ejecutarse.
func runCheck(ctx context.Context, dir string, name string, args ...string) (output string, ok, ran bool) {
	ctx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	var out limitedBuffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	var exitErr *exec.ExitError
	switch {
	case err == nil:
		return "", true, true
	case errors.As(err, &exitErr):
		return textutil.Strip(out.String()), false, true
	}
	return "", false, false
}

func checkPython(ctx context.Context, workspace, path string) (string, string) {
	if ruff, err := exec.LookPath("ruff"); err == nil {
		out, ok, ran := runCheck(ctx, workspace, ruff, "check", "--no-fix", "--output-format", "concise", path)
		if ran {
			return "ruff", ifFailed(ok, out)
		}
	}
	for _, name := range []string{"python3", "python"} {
		if python, err := exec.LookPath(name); err == nil {
			out, ok, ran := runCheck(ctx, workspace, python, "-c", pySyntaxCheck, path)
			if ran {
				return "py_compile", ifFailed(ok, out)
			}
		}
	}
	return "", ""
}

func checkJS(ctx context.Context, workspace, path string) (string, string) {
	binName := "eslint"
	if runtime.GOOS == "windows" {
		binName += ".cmd"
	}
	eslint := filepath.Join(workspace, "node_modules", ".bin", binName)
	if _, err := os.Stat(eslint); err == nil {
		out, ok, ran := runCheck(ctx, workspace, eslint, "--no-color", path)
		if ran {
			return "eslint", ifFailed(ok, out)
		}
	}
	ext := strings.ToLower(filepath.Ext(path))
	if ext == ".ts" || ext == ".tsx" || ext == ".jsx" {
		return "", ""
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return "", ""
	}
	out, ok, ran := runCheck(ctx, workspace, node, "--check", path)
	if !ran {
		return "", ""
	}
	return "node --check", ifFailed(ok, out)
}

func checkJSON(path string) (string, string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "json", err.Error()
	}
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		var syntax *json.SyntaxError
		if errors.As(err, &syntax) {
			line := bytes.Count(data[:min(int(syntax.Offset), len(data))], []byte("\n")) + 1
			return "json", fmt.Sprintf("%v (línea %d)", err, line)
		}
		return "json", err.Error()
	}
	return "json", ""
}

// checkGo comprueba la sintaxis con el analizador de Go, sin ejecutar nada.
func checkGo(path string) (string, string) {
	if _, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.SkipObjectResolution); err != nil {
		return "go/parser", err.Error()
	}
	return "go/parser", ""
}

func ifFailed(ok bool, out string) string {
	if ok {
		return ""
	}
	return out
}

// VerifyAfter pasa el verificador tras una edición y añade los errores al
// resultado que ve el modelo. Devuelve la herramienta, los errores y el
// resultado ampliado.
func VerifyAfter(ctx context.Context, workspace, tool string, args map[string]any, result string) (checker, errs, out string) {
	if !isEditTool(tool) || strings.HasPrefix(result, "[ERROR]") {
		return "", "", result
	}
	target, _, err := tools.ResolveSafe(workspace, stringArg(args, "path"))
	if err != nil {
		return "", "", result
	}
	checker, errs = VerifyFile(ctx, workspace, target)
	if errs != "" {
		result += fmt.Sprintf("\n[verificación %s] el archivo tiene errores; corrígelos:\n%s", checker, errs)
	}
	return checker, errs, result
}
