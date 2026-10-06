//go:build !windows

package clipboard

import (
	"context"
	"os/exec"
	"time"
)

func readImage(dir string) (string, string) {
	return fromHelpers(dir, exec.LookPath, runHelper)
}

func runHelper(name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).Output()
}
