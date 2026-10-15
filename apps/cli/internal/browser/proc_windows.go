package browser

import "syscall"

const (
	createNewProcessGroup   = 0x00000200
	processQueryLimitedInfo = 0x1000
	stillActive             = 259
)

// Sin HideWindow (a diferencia de process.Command): la ventana del navegador
// tiene que verse.
func procAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: createNewProcessGroup}
}

func processAlive(pid int) bool {
	h, err := syscall.OpenProcess(processQueryLimitedInfo, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)
	var code uint32
	if syscall.GetExitCodeProcess(h, &code) != nil {
		return false
	}
	return code == stillActive
}
