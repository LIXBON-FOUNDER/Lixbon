package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type Bucket struct {
	Unlimited bool    `json:"unlimited"`
	Percent   float64 `json:"percent"`
	ResetAt   string  `json:"reset_at"`
}

// Usage es el plan vigente y las cuotas de sesión (4 h) y semana: el mismo
// endpoint y contrato que usan desktop, web y móvil.
type Usage struct {
	Plan struct {
		Name string `json:"name"`
	} `json:"plan"`
	Buckets struct {
		Session Bucket `json:"session"`
		Week    Bucket `json:"week"`
	} `json:"buckets"`
}

func (c *Client) Usage(ctx context.Context) (Usage, error) {
	var u Usage
	err := c.doJSON(ctx, http.MethodGet, c.Server+"/api/account/usage", nil, 20*time.Second, true, &u)
	return u, err
}

type Node struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Online         bool     `json:"online"`
	CircuitBreaker bool     `json:"circuit_breaker"`
	Score          float64  `json:"score"`
	Models         []string `json:"modelos"`
}

func (c *Client) Nodes(ctx context.Context) ([]Node, error) {
	var data struct {
		Nodes []Node `json:"nodos"`
	}
	err := c.doJSON(ctx, http.MethodGet, c.Server+"/api/nodes", nil, 20*time.Second, true, &data)
	return data.Nodes, err
}

type KeyInfo struct {
	PlanName string
	KeyModel string
}

func (c *Client) KeyInfo(ctx context.Context) (KeyInfo, error) {
	var data struct {
		Plan struct {
			Name string `json:"name"`
		} `json:"plan"`
		KeyModel string `json:"key_model"`
	}
	err := c.doJSON(ctx, http.MethodGet, c.Server+"/api/key/info", nil, 15*time.Second, true, &data)
	return KeyInfo{PlanName: data.Plan.Name, KeyModel: data.KeyModel}, err
}

// ResetIn es cuánto falta para un reset_at (ISO, UTC si no trae zona):
// «en 2h 14min», «en 3 días».
func ResetIn(iso string, now time.Time) string {
	if iso == "" {
		return ""
	}
	target, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		target, err = time.Parse("2006-01-02T15:04:05", strings.TrimSuffix(iso, "Z"))
		if err != nil {
			return ""
		}
	}
	delta := max(0, int(target.Sub(now).Seconds()))
	switch {
	case delta < 3600:
		return fmt.Sprintf("en %d min", max(1, delta/60))
	case delta < 86400:
		return fmt.Sprintf("en %dh %dmin", delta/3600, (delta%3600)/60)
	}
	days := delta / 86400
	if days == 1 {
		return "en 1 día"
	}
	return fmt.Sprintf("en %d días", days)
}
