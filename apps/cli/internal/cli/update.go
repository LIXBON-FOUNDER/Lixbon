package cli

import (
	"context"
	"fmt"

	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/update"
)

func (a *App) update(ctx context.Context, args []string) int {
	fs := a.flagSet("update")
	check := fs.Bool("check", false, "solo comprobar si hay una versión nueva")
	if code, stop := parseFlags(fs, args); stop {
		return code
	}
	newUpdater := a.NewUpdater
	if newUpdater == nil {
		newUpdater = update.New
	}
	updater, err := newUpdater(update.ManifestURLForConfig(config.Load(a.ConfigPath)))
	if err != nil {
		fmt.Fprintf(a.Stderr, "update: %v\n", err)
		return 1
	}
	message, err := update.Run(ctx, updater, *check)
	if err != nil {
		if ctx.Err() != nil {
			return 0
		}
		fmt.Fprintf(a.Stderr, "update: %v\n", err)
		return 1
	}
	fmt.Fprintln(a.Stdout, message)
	return 0
}
