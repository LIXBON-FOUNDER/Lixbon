//go:build windows

package process

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"unsafe"
)

// shellCommand arranca cmd.exe con la línea de comandos tal cual (Go
// reescribiría las comillas) y en su propio grupo de procesos. /d evita que
// el AutoRun del registro altere el comando.
func shellCommand(ctx context.Context, dir, command string) *exec.Cmd {
	comspec := os.Getenv("COMSPEC")
	if comspec == "" {
		comspec = "cmd.exe"
	}
	cmd := exec.CommandContext(ctx, comspec)
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CmdLine:       `"` + comspec + `" /d /s /c "` + command + `"`,
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
	return cmd
}

func killTree(pid int) {
	kill := exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(pid))
	kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = kill.Run()
}

var multiByteToWideChar = syscall.NewLazyDLL("kernel32.dll").NewProc("MultiByteToWideChar")

const cpOEM = 1

// decodeLegacy interpreta la salida con la página de códigos OEM de la
// consola, que es la que usan los comandos internos de cmd.
func decodeLegacy(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	n, _, _ := multiByteToWideChar.Call(cpOEM, 0, uintptr(unsafe.Pointer(&raw[0])), uintptr(len(raw)), 0, 0)
	if n == 0 {
		return string(raw)
	}
	wide := make([]uint16, n)
	multiByteToWideChar.Call(cpOEM, 0, uintptr(unsafe.Pointer(&raw[0])), uintptr(len(raw)),
		uintptr(unsafe.Pointer(&wide[0])), n)
	return syscall.UTF16ToString(wide)
}
