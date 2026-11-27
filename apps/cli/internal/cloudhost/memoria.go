package cloudhost

import (
	"encoding/json"
	"os"
	"path/filepath"

	"lixbon.com/cli/internal/history"
)

// La conversación del agente sobrevive a las pausas: el contenedor se borra
// al pausar (y con él /tmp), pero /workspace es un volumen. Tras cada turno se
// guarda aquí lo que el modelo necesita para seguir (su historial) y lo que
// ve un mando que se une tarde (el snapshot). Va fuera del repo clonado, así
// que nunca entra en un commit.

const memoriaVersion = 1

// Tope del archivo: por encima se sueltan los mensajes más antiguos.
const memoriaMaxBytes = 8 << 20

type memoria struct {
	Version int               `json:"version"`
	History []history.Message `json:"history"`
	Log     []map[string]any  `json:"log,omitempty"`
	Tokens  int               `json:"tokens,omitempty"`
}

func rutaMemoria(root, repo string) string {
	dir := ".lixbon"
	if repoName(repo) == dir { // un repo que se llama así ocupa esa carpeta
		dir = ".lixbon-sesion"
	}
	return filepath.Join(root, dir, "chat.json")
}

// guardarMemoria escribe el archivo entero y lo cambia de golpe: una pausa a
// mitad de escritura no deja un JSON cortado.
func guardarMemoria(path string, m memoria) error {
	m.Version = memoriaVersion
	// Las imágenes van en base64 dentro del mensaje: no se guardan (el modelo
	// conserva lo que dijo de ellas).
	hist := make([]history.Message, len(m.History))
	for i, msg := range m.History {
		msg.Images = nil
		hist[i] = msg
	}
	m.History = hist
	data, err := json.Marshal(m)
	for err == nil && len(data) > memoriaMaxBytes && len(m.History) > 2 {
		m.History = recortar(m.History)
		data, err = json.Marshal(m)
	}
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// recortar suelta la mitad más antigua sin dejar un resultado de herramienta
// huérfano al principio (el gateway lo rechazaría).
func recortar(msgs []history.Message) []history.Message {
	i := len(msgs) / 2
	for i < len(msgs) && (msgs[i].Role != "user" || msgs[i].IsToolResult()) {
		i++
	}
	if i >= len(msgs) {
		return nil
	}
	return append([]history.Message(nil), msgs[i:]...)
}

func cargarMemoria(path string) (memoria, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return memoria{}, false
	}
	var m memoria
	if json.Unmarshal(data, &m) != nil || m.Version != memoriaVersion {
		return memoria{}, false
	}
	return m, true
}

func (h *Host) saveMemory() {
	if h.chat == nil {
		return
	}
	h.mu.Lock()
	log := append([]map[string]any(nil), h.log...)
	h.mu.Unlock()
	_ = guardarMemoria(rutaMemoria(h.opts.Root, h.opts.Repo),
		memoria{History: h.chat.History, Log: log, Tokens: h.chat.SessionTokens})
}

// loadMemory recupera la conversación de antes de la pausa. Una herramienta
// que quedó a medias al pausar ya no va a terminar: se marca como cerrada.
func (h *Host) loadMemory() bool {
	m, ok := cargarMemoria(rutaMemoria(h.opts.Root, h.opts.Repo))
	if !ok {
		return false
	}
	h.chat.History = m.History
	h.chat.SessionTokens = m.Tokens
	for _, item := range m.Log {
		if item["role"] == "tool" && item["pending"] == true {
			item["pending"], item["ok"] = false, false
		}
	}
	h.mu.Lock()
	h.log = m.Log
	h.mu.Unlock()
	return len(m.History) > 0
}
