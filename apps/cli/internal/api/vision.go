package api

import (
	"bytes"
	"encoding/base64"
)

// openAIVision convierte el campo images del gateway Lixbon al formato de
// visión estándar de OpenAI (content como lista de partes), que es el que
// entienden LM Studio, Ollama, OpenAI y OpenRouter.
func openAIVision(messages []map[string]any) []map[string]any {
	out := make([]map[string]any, len(messages))
	for i, m := range messages {
		converted := make(map[string]any, len(m))
		for k, v := range m {
			converted[k] = v
		}
		images, _ := m["images"].([]any)
		if len(images) == 0 {
			out[i] = converted
			continue
		}
		text, _ := m["content"].(string)
		parts := []map[string]any{{"type": "text", "text": text}}
		for _, image := range images {
			encoded, _ := image.(string)
			parts = append(parts, map[string]any{
				"type":      "image_url",
				"image_url": map[string]any{"url": "data:" + imageMIME(encoded) + ";base64," + encoded},
			})
		}
		delete(converted, "images")
		converted["content"] = parts
		out[i] = converted
	}
	return out
}

func imageMIME(encoded string) string {
	head := encoded[:min(len(encoded), 24)]
	head = head[:len(head)/4*4]
	raw, _ := base64.StdEncoding.DecodeString(head)
	switch {
	case bytes.HasPrefix(raw, []byte("\xff\xd8\xff")):
		return "image/jpeg"
	case len(raw) >= 12 && bytes.Equal(raw[:4], []byte("RIFF")) && bytes.Equal(raw[8:12], []byte("WEBP")):
		return "image/webp"
	}
	return "image/png"
}
