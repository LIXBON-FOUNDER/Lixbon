package tools

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif"  // DecodeConfig de GIF
	_ "image/jpeg" // y de JPEG
	_ "image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "golang.org/x/image/webp" // y de WebP
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

func (tb *Toolbox) showImage(ctx context.Context, args map[string]any) (string, error) {
	path, err := textArg(args, "path", "")
	if err != nil {
		return "", err
	}
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("falta path")
	}
	target := path
	if lower := strings.ToLower(path); strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
		// Una URL se descarga aquí: así el agente no gasta pasos en curl.
		if target, err = tb.downloadImage(ctx, path); err != nil {
			return "", err
		}
	} else if !filepath.IsAbs(target) {
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
	} else if u, err := url.Parse(path); err == nil && u.Host != "" {
		shown.Name = u.Host + u.EscapedPath()
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
	return "Imagen enseñada al usuario: " + shown.Name + size + ". Ya la ve: no la describas si no te lo pide.", nil
}

// downloadImage baja una imagen de la web a la carpeta temporal de imágenes y
// devuelve su ruta.
func (tb *Toolbox) downloadImage(ctx context.Context, raw string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return "", fmt.Errorf("no se pudo descargar %s: %v", raw, err)
	}
	req.Header.Set("User-Agent", fetchUserAgent)
	req.Header.Set("Accept", "image/png,image/jpeg,image/webp,image/gif,image/*;q=0.8")
	client := tb.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil && !errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", ctx.Err()
		}
		return "", fmt.Errorf("no se pudo descargar %s: %v", raw, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("HTTP %d al descargar %s", resp.StatusCode, raw)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, MaxShownImage+1))
	if err != nil {
		return "", fmt.Errorf("no se pudo descargar %s: %v", raw, err)
	}
	if len(data) > MaxShownImage {
		return "", fmt.Errorf("%s pesa más de 8 MB", raw)
	}
	mime := http.DetectContentType(data)
	ext := ""
	for e, known := range imageMimes {
		if known == mime && e != ".jpeg" {
			ext = e
		}
	}
	if ext == "" {
		return "", fmt.Errorf("%s no es una imagen PNG, JPEG, GIF o WebP (es %s)", raw, mime)
	}
	dir := filepath.Join(os.TempDir(), "lixbon-imagenes")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(raw))
	path := filepath.Join(dir, hex.EncodeToString(sum[:8])+ext)
	return path, os.WriteFile(path, data, 0o644)
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
