package api

import (
	"context"
	"errors"
	"sync"
	"time"

	"lixbon.com/cli/internal/config"
)

// renewMargin renueva el access un poco antes de que caduque: una petición
// larga que sale con un token a punto de expirar no debe recibir 401.
const renewMargin = 2 * time.Minute

// Session renueva el access token de un login por navegador. Las copias del
// Client comparten el puntero, así que todas ven el token renovado.
type Session struct {
	mu      sync.Mutex
	path    string
	profile string
	stored  config.StoredSession
}

func newSession(cfg config.Config, stored config.StoredSession) *Session {
	return &Session{path: cfg.SessionFile(), profile: cfg.ActiveProfile(), stored: stored}
}

func (s *Session) access() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stored.Access
}

func (s *Session) refresh() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stored.Refresh
}

func (s *Session) due() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return time.Until(s.stored.ExpiresAt) < renewMargin
}

// renew obtiene un access nuevo salvo que alguien se haya adelantado: otra
// goroutine (el token ya no es `stale`) u otro proceso del CLI (sessions.json
// trae un refresh distinto). Si dos procesos renuevan a la vez, el servidor
// responde 409 al segundo y este adopta lo que guardó el primero.
func (s *Session) renew(ctx context.Context, c *Client, stale string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stored.Access != stale || s.adoptFromDisk() {
		return nil
	}
	t, err := c.refreshTokens(ctx, s.stored.Refresh)
	var apiErr *Error
	if errors.As(err, &apiErr) && apiErr.Status == 409 && s.adoptFromDisk() {
		return nil
	}
	if err != nil {
		return err
	}
	s.stored.Access, s.stored.Refresh, s.stored.ExpiresAt = t.Access, t.Refresh, t.ExpiresAt
	return config.WriteSession(s.path, s.profile, s.stored)
}

func (s *Session) adoptFromDisk() bool {
	disk, ok := config.ReadSession(s.path, s.profile)
	if !ok || disk.Server != s.stored.Server || disk.Refresh == s.stored.Refresh {
		return false
	}
	s.stored = disk
	return true
}
