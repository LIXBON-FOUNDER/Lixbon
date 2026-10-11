package api

import (
	"context"
	"net/http"
	"os"
	"time"
)

const authTimeout = 30 * time.Second

// LoginClient pide al servidor una sesión de dispositivo (access + refresh) en
// lugar de una API key.
const LoginClient = "cli"

// legacyKeyName lo entienden los gateways anteriores a las sesiones de
// dispositivo: rotan por nombre y así no tocan la clave del escritorio.
const legacyKeyName = "lixbon CLI"

// IDEUser es la cuenta que devuelve el canje del login por navegador.
type IDEUser struct {
	Email    string `json:"email"`
	PlanName string `json:"plan_name"`
}

type Tokens struct {
	Access    string    `json:"access_token"`
	Refresh   string    `json:"refresh_token"`
	ExpiresAt time.Time `json:"expires_at"`
}

// ExchangeIDEToken canjea el token de un solo uso que trae el navegador (y el
// verificador PKCE) por la sesión de este dispositivo.
func (c *Client) ExchangeIDEToken(ctx context.Context, token, verifier string) (Tokens, IDEUser, error) {
	var data struct {
		Tokens
		APIKey string  `json:"api_key"`
		User   IDEUser `json:"user"`
	}
	host, _ := os.Hostname()
	payload := map[string]any{
		"token": token, "verifier": verifier, "client": LoginClient, "device_name": host,
		"key_name": legacyKeyName,
	}
	err := c.doJSON(ctx, http.MethodPost, c.Server+"/api/auth/ide/exchange", payload, authTimeout, false, &data)
	if data.Access == "" {
		data.Access = data.APIKey
	}
	if err == nil && data.Access == "" {
		err = &Error{Message: "El servidor no entregó una sesión. Vuelve a intentarlo."}
	}
	return data.Tokens, data.User, err
}

func (c *Client) refreshTokens(ctx context.Context, refresh string) (Tokens, error) {
	var t Tokens
	err := c.doJSON(ctx, http.MethodPost, c.Server+"/api/auth/refresh",
		map[string]any{"refresh_token": refresh}, authTimeout, false, &t)
	return t, err
}

// Logout cierra en el servidor la sesión de navegador de este dispositivo.
// Una API key no se toca: las keys solo se revocan desde la cuenta.
func (c *Client) Logout(ctx context.Context) error {
	if c.Session == nil {
		return nil
	}
	return c.RevokeRefresh(ctx, c.Session.refresh())
}

func (c *Client) RevokeRefresh(ctx context.Context, refresh string) error {
	return c.doJSON(ctx, http.MethodPost, c.Server+"/api/auth/logout",
		map[string]any{"refresh_token": refresh}, authTimeout, false, nil)
}
