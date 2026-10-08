//go:build !windows

package process

import (
	"context"
	"os/exec"
	"syscall"

	"lixbon.com/cli/internal/textutil"
)

// shellCommand arranca sh en su propio grupo de procesos para poder matar a
// los hijos (npm, pytest…) junto con el shell.
func shellCommand(ctx context.Context, dir, command string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", command)
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd
}

func killTree(pid int) {
	_ = syscall.Kill(-pid, syscall.SIGKILL)
}

func decodeLegacy(raw []byte) string { return textutil.DecodeLossy(raw) }
