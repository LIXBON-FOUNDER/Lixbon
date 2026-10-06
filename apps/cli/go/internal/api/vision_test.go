package api

import (
	"encoding/base64"
	"reflect"
	"testing"
)

func TestOpenAIVisionTurnsImagesIntoContentParts(t *testing.T) {
	png := base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\n0000"))
	jpg := base64.StdEncoding.EncodeToString([]byte("\xff\xd8\xff\xe0000000000"))
	webp := base64.StdEncoding.EncodeToString([]byte("RIFF0000WEBPVP8 "))
	in := []map[string]any{
		{"role": "user", "content": "hola"},
		{"role": "user", "content": "mira", "images": []any{png, jpg, webp}},
	}
	got := openAIVision(in)

	if !reflect.DeepEqual(got[0], in[0]) {
		t.Fatalf("un mensaje sin imágenes no cambia: %v", got[0])
	}
	parts, _ := got[1]["content"].([]map[string]any)
	if len(parts) != 4 || parts[0]["text"] != "mira" {
		t.Fatalf("partes: %v", got[1]["content"])
	}
	for i, want := range []string{"data:image/png;base64," + png, "data:image/jpeg;base64," + jpg, "data:image/webp;base64," + webp} {
		if url := parts[i+1]["image_url"].(map[string]any)["url"]; url != want {
			t.Errorf("imagen %d: %v", i, url)
		}
	}
	if _, left := got[1]["images"]; left {
		t.Fatal("el campo images es solo del gateway Lixbon")
	}
	if _, kept := in[1]["images"]; !kept {
		t.Fatal("el mensaje original no se modifica")
	}
}
