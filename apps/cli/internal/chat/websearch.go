package chat

import (
	"context"
	"errors"

	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/config"
)

// errNoLixbonAccount: con un proveedor externo la búsqueda va por la cuenta
// de Lixbon, y no hay ninguna guardada.
var errNoLixbonAccount = errors.New("con este proveedor la búsqueda web va por tu cuenta de Lixbon y no hay ninguna guardada; /login la añade")

// LixbonClient es el cliente de un gateway Lixbon con sesión: el activo si lo
// es, o el primer perfil Lixbon guardado (antes «lixbon») si el activo es otro
// proveedor. nil si no hay ninguno.
func (c *Chat) LixbonClient() *api.Client {
	if !c.Client.Generic {
		if c.Client.APIKey == "" && c.Client.Session == nil {
			return nil
		}
		return c.Client
	}
	profiles := c.Cfg.Profiles()
	for _, name := range append([]string{config.DefaultProfile}, c.Cfg.ProfileNames()...) {
		if p, ok := profiles[name]; !ok || p.Generic {
			continue
		}
		if l := api.ForProfile(c.Cfg, name); l.APIKey != "" || l.Session != nil {
			return l
		}
	}
	return nil
}

// webRelay es el buscador del agente: el gateway Lixbon aunque el modelo sea
// de otro proveedor, que no tiene búsqueda propia. Se decide en cada búsqueda
// porque el proveedor puede cambiar a mitad de sesión.
type webRelay struct{ c *Chat }

func (w webRelay) WebSearch(ctx context.Context, query string, limit int) ([]map[string]any, error) {
	client := w.c.LixbonClient()
	if client == nil {
		return nil, errNoLixbonAccount
	}
	return client.WebSearch(ctx, query, limit)
}
