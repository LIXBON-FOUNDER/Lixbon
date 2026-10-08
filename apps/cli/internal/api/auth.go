package api

import (
	"context"
	"net/http"
	"time"
)

const authTimeout = 30 * time.Second

// LoginKeyName hace que el login del CLI no desactive la API key de la app de
// escritorio de la misma cuenta: el servidor rota las claves por nombre.
const LoginKeyName = "lixbon CLI"

// Login entrega una API key propia y rotable (el mismo flujo que la app de
// escritorio) a cambio de correo y contraseña.
func (c *Client) Login(ctx context.Context, email, password string) (string, error) {
	var data struct {
		APIKey string `json:"api_key"`
	}
	payload := map[string]any{"email": email, "password": password, "issue_api_key": true, "key_name": LoginKeyName}
	err := c.doJSON(ctx, http.MethodPost, c.Server+"/api/auth/login", payload, authTimeout, false, &data)
	return data.APIKey, err
}

func (c *Client) Register(ctx context.Context, email, password, firstName, lastName string) error {
	payload := map[string]any{"email": email, "password": password, "first_name": firstName, "last_name": lastName}
	return c.doJSON(ctx, http.MethodPost, c.Server+"/api/auth/register", payload, authTimeout, false, nil)
}
