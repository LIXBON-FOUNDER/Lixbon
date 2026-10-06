//go:build !windows

package process

import "syscall"

func processAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}
