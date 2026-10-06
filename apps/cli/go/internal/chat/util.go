package chat

import (
	"crypto/rand"
	"encoding/json"
	"fmt"

	"lixbon.com/cli/internal/history"
	"lixbon.com/cli/internal/toolspec"
)

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func toMaps(messages []history.Message) []map[string]any {
	out := make([]map[string]any, len(messages))
	for i, m := range messages {
		raw, _ := json.Marshal(m)
		_ = json.Unmarshal(raw, &out[i])
	}
	return out
}

// webSearchValue traduce el modo de búsqueda web al valor del payload: true,
// false o "auto" (el modelo decide).
func webSearchValue(mode string) any {
	switch mode {
	case "on":
		return true
	case "off":
		return false
	}
	return "auto"
}

func toolSchemas() []map[string]any { return toolspec.Schemas() }
