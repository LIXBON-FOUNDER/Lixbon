//go:build !windows

package browser

import "syscall"

// Grupo propio: el Ctrl+C de la terminal no debe cerrar el navegador.
func procAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}
