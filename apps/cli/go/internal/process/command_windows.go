//go:build windows

package process

import (
	"os/exec"
	"syscall"
)

// Command prepara un programa sin shell en su propio grupo de procesos, sin
// ventana, para poder matar también a sus hijos (npx lanza node).
func Command(dir, name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
		HideWindow:    true,
	}
	return cmd
}

// KillTree mata el proceso y todo su árbol.
func KillTree(pid int) { killTree(pid) }
