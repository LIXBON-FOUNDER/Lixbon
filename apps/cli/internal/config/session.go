package config

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// StoredSession es la sesión de un login por navegador: un access token corto
// y el refresh que lo renueva.
//
// Vive en sessions.json y no en config.json porque el refresh rota en cada uso:
// cualquier guardado del config con una copia anterior lo pisaría, y el
// servidor trata un refresh ya usado como robado y cierra la sesión.
type StoredSession struct {
	Server    string    `json:"server"`
	Access    string    `json:"access_token"`
	Refresh   string    `json:"refresh_token"`
	ExpiresAt time.Time `json:"expires_at"`
}

// SessionFile es sessions.json junto al config; vacío si el config no se leyó
// de un archivo.
func (c Config) SessionFile() string {
	if c.path == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(c.path), "sessions.json")
}

// ActiveSession devuelve la sesión del proveedor activo, si es del mismo
// servidor al que apunta ahora.
func (c Config) ActiveSession() (StoredSession, bool) {
	if c.IsGeneric() {
		return StoredSession{}, false
	}
	s, ok := ReadSession(c.SessionFile(), c.ActiveProfile())
	if !ok || s.Server != ServerBase(c.BaseURL) {
		return StoredSession{}, false
	}
	return s, true
}

func readSessions(path string) map[string]StoredSession {
	sessions := map[string]StoredSession{}
	if path == "" {
		return sessions
	}
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, &sessions)
	}
	return sessions
}

func ReadSession(path, profile string) (StoredSession, bool) {
	s, ok := readSessions(path)[profile]
	return s, ok && s.Access != "" && s.Refresh != ""
}

func WriteSession(path, profile string, s StoredSession) error {
	if path == "" {
		return errors.New("no hay archivo de configuración donde guardar la sesión")
	}
	sessions := readSessions(path)
	sessions[profile] = s
	return writeSessions(path, sessions)
}

func RemoveSession(path, profile string) error {
	sessions := readSessions(path)
	if _, ok := sessions[profile]; !ok {
		return nil
	}
	delete(sessions, profile)
	if len(sessions) == 0 {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	return writeSessions(path, sessions)
}

func writeSessions(path string, sessions map[string]StoredSession) error {
	body, err := json.MarshalIndent(sessions, "", "  ")
	if err != nil {
		return err
	}
	return writePrivate(path, body)
}
