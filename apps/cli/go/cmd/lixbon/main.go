package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"

	"lixbon.com/cli/internal/cli"
)

func main() {
	app, err := cli.NewApp()
	if err != nil {
		fmt.Fprintf(os.Stderr, "lixbon: %v\n", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	code := app.Run(ctx, os.Args[1:])
	stop()
	os.Exit(code)
}
