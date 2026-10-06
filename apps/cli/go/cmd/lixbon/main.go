package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"

	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/cli"
	"lixbon.com/cli/internal/tui"
)

func main() {
	app, err := cli.NewApp()
	if err != nil {
		fmt.Fprintf(os.Stderr, "lixbon: %v\n", err)
		os.Exit(1)
	}
	app.Interactive = func(ctx context.Context, opts chat.Options) int {
		return tui.Interactive(ctx, app.Stdout, app.Stderr, app.ConfigPath, opts)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	code := app.Run(ctx, os.Args[1:])
	stop()
	os.Exit(code)
}
