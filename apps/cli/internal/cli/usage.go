package cli

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"

	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/config"
)

const usageBarWidth = 24

// usageBar usa el redondeo de Python (a la pareja más cercana) para que la
// salida coincida con la del CLI Python.
func usageBar(pct int) string {
	filled := int(math.RoundToEven(float64(usageBarWidth) * float64(pct) / 100))
	return strings.Repeat("#", filled) + strings.Repeat(".", usageBarWidth-filled)
}

func (a *App) printBucket(label string, bucket api.Bucket) {
	fmt.Fprintln(a.Stdout, label)
	if bucket.Unlimited {
		fmt.Fprintf(a.Stdout, "  [%s]  ilimitado\n", strings.Repeat("#", usageBarWidth))
		return
	}
	pct := min(100, int(math.RoundToEven(bucket.Percent)))
	fmt.Fprintf(a.Stdout, "  [%s]  %d%% usado\n", usageBar(pct), pct)
	if reset := api.ResetIn(bucket.ResetAt, time.Now()); reset != "" {
		fmt.Fprintf(a.Stdout, "  Se reinicia %s\n", reset)
	}
}

func (a *App) usageReport(ctx context.Context) int {
	cfg := config.Load(a.ConfigPath)
	if cfg.IsGeneric() {
		fmt.Fprintf(a.Stdout, "El proveedor «%s» no es un gateway Lixbon: no hay uso de cuenta que mostrar.\n", cfg.ActiveProfile())
		return 1
	}
	usage, err := api.FromConfig(cfg).Usage(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return 0
		}
		fmt.Fprintf(a.Stdout, "No se pudo obtener el uso. Verifica tu sesión. Error: %v\n", err)
		return 1
	}
	name := usage.Plan.Name
	if name == "" {
		name = "-"
	}
	fmt.Fprintf(a.Stdout, "Plan %s\n\n", name)
	a.printBucket("Sesion (4h)", usage.Buckets.Session)
	fmt.Fprintln(a.Stdout)
	a.printBucket("Semana (todos los modelos)", usage.Buckets.Week)
	return 0
}
