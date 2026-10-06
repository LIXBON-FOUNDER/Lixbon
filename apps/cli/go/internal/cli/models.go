package cli

import (
	"context"
	"fmt"

	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/config"
)

func (a *App) models(ctx context.Context) int {
	cfg := config.Load(a.ConfigPath)
	if cfg.APIKey == "" {
		fmt.Fprintln(a.Stdout, "Primero inicia sesión: lixbon (o lixbon setup)")
		return 1
	}
	models, err := api.New(cfg.BaseURL, cfg.APIKey).Models(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return 0
		}
		fmt.Fprintf(a.Stdout, "No se pudieron listar los modelos: %v\n", err)
		return 1
	}
	if len(models) == 0 {
		fmt.Fprintln(a.Stdout, "No hay modelos disponibles.")
		return 0
	}
	fmt.Fprintln(a.Stdout, "Modelos disponibles:")
	for _, model := range models {
		fmt.Fprintf(a.Stdout, "- %s\n", model)
	}
	return 0
}
