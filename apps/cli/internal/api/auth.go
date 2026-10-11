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

// IDEUser es la cuenta que devuelve el canje del login por navegador.
type IDEUser struct {
	Email    string `json:"email"`
	PlanName string `json:"plan_name"`
}

// ExchangeIDEToken canjea el token de un solo uso que trae el navegador (y el
// verificador PKCE) por una API key propia del CLI.
func (c *Client) ExchangeIDEToken(ctx context.Context, token, verifier, keyName string) (string, IDEUser, error) {
	var data struct {
		APIKey string  `json:"api_key"`
		User   IDEUser `json:"user"`
	}
	payload := map[string]any{"token": token, "verifier": verifier, "key_name": keyName}
	err := c.doJSON(ctx, http.MethodPost, c.Server+"/api/auth/ide/exchange", payload, authTimeout, false, &data)
	if err == nil && data.APIKey == "" {
		err = &Error{Message: "El servidor no entregó una API key. Vuelve a intentarlo."}
	}
	return data.APIKey, data.User, err
}
