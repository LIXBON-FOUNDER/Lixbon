package tools

import (
	"errors"
	"fmt"
	"image"
	_ "image/gif"  // DecodeConfig de GIF
	_ "image/jpeg" // y de JPEG
	_ "image/png"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ShownImage es una imagen que el agente enseña al usuario con show_image: la
// terminal pinta su miniatura y /remote la lleva al móvil.
type ShownImage struct {
	Path    string // absoluta
	Name    string // como la ve el usuario: relativa al workspace o el nombre
	Mime    string
	W, H    int
	Caption string
}

// MaxShownImage es lo más que pesa una imagen que se enseña (el gateway
// rechaza más de 8 MB).
const MaxShownImage = 8 << 20

var imageMimes = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
}

// ImageMime es el tipo de una imagen que se puede enseñar, o "" si no lo es.
func ImageMime(path string) string {
	if mime, ok := imageMimes[strings.ToLower(filepath.Ext(path))]; ok {
		return mime
	}
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	head := make([]byte, 512)
	n, _ := f.Read(head)
	mime := http.DetectContentType(head[:n])
	for _, known := range imageMimes {
		if mime == known {
			return mime
		}
	}
	return ""
}

func (tb *Toolbox) showImage(args map[string]any) (string, error) {
	path, err := textArg(args, "path", "")
	if err != nil {
		return "", err
	}
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("falta path")
	}
	target := path
	if !filepath.IsAbs(target) {
		target = filepath.Join(tb.Root, target)
	}
	info, err := os.Stat(target)
	switch {
	case err != nil:
		return "", fmt.Errorf("no existe %s", path)
	case info.IsDir():
		return "", fmt.Errorf("%s es una carpeta", path)
	case info.Size() > MaxShownImage:
		return "", fmt.Errorf("%s pesa más de 8 MB", path)
	}
	mime := ImageMime(target)
	if mime == "" {
		return "", fmt.Errorf("%s no es una imagen PNG, JPEG, GIF o WebP", path)
	}
	shown := ShownImage{Path: target, Name: path, Mime: mime, Caption: strings.TrimSpace(stringOf(args["caption"]))}
	if rel, err := filepath.Rel(tb.Root, target); err == nil && !strings.HasPrefix(rel, "..") {
		shown.Name = filepath.ToSlash(rel)
	} else {
		shown.Name = filepath.Base(target)
	}
	if f, err := os.Open(target); err == nil {
		if cfg, _, err := image.DecodeConfig(f); err == nil {
			shown.W, shown.H = cfg.Width, cfg.Height
		}
		f.Close()
	}
	if tb.OnImage != nil {
		tb.OnImage(shown)
	}
	size := ""
	if shown.W > 0 {
		size = fmt.Sprintf(" (%d×%d)", shown.W, shown.H)
	}
	return "Imagen enseñada al usuario: " + shown.Name + size + ".", nil
}

func stringOf(v any) string {
	s, _ := v.(string)
	return s
}

// ScreenshotDir es donde browser_screenshot deja sus capturas para que
// show_image pueda enseñarlas.
func ScreenshotDir() string { return filepath.Join(os.TempDir(), "lixbon-capturas") }

// saveScreenshot guarda la captura (JPEG) y devuelve su ruta.
func saveScreenshot(data []byte) (string, error) {
	dir := ScreenshotDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "captura-"+time.Now().Format("20060102-150405.000")+".jpg")
	return path, os.WriteFile(path, data, 0o644)
}
