//go:build windows

package process

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// Command prepara un programa sin shell en su propio grupo de procesos, sin
// ventana, para poder matar también a sus hijos (npx lanza node).
func Command(dir, name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	attr := &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
		HideWindow:    true,
	}
	// Un .cmd (npx, pnpm…) lo ejecuta cmd.exe, que quita las primeras y las
	// últimas comillas de la línea: con la ruta en «Program Files» y un
	// argumento entrecomillado se queda en «C:\Program». Con /s y la línea
	// envuelta en comillas propias las conserva todas.
	if ext := strings.ToLower(filepath.Ext(name)); ext == ".cmd" || ext == ".bat" {
		shell := os.Getenv("ComSpec")
		if shell == "" {
			shell = "cmd.exe"
		}
		parts := []string{syscall.EscapeArg(name)}
		for _, a := range args {
			parts = append(parts, syscall.EscapeArg(a))
		}
		cmd = exec.Command(shell)
		attr.CmdLine = `/d /s /c "` + strings.Join(parts, " ") + `"`
	}
	cmd.Dir = dir
	cmd.SysProcAttr = attr
	return cmd
}

// KillTree mata el proceso y todo su árbol.
func KillTree(pid int) { killTree(pid) }
