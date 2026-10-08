// Package clipboard recupera la imagen del portapapeles y la guarda como PNG
// bajo ~/.lixbon/pastes. Es el /paste (Alt+V) del CLI.
package clipboard

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// keepPastes son las capturas que se conservan en disco: pesan y no vuelven a
// hacer falta una vez el modelo las ha visto.
const keepPastes = 20

var pngSignature = []byte("\x89PNG\r\n\x1a\n")

func pasteDir(home string) (string, error) {
	dir := filepath.Join(home, "pastes")
	return dir, os.MkdirAll(dir, 0o700)
}

func newPath(dir string) string {
	return filepath.Join(dir, fmt.Sprintf("paste-%s-%03d.png", time.Now().Format("20060102-150405"), os.Getpid()%1000))
}

func prune(dir string) {
	matches, _ := filepath.Glob(filepath.Join(dir, "paste-*.png"))
	type entry struct {
		path string
		mod  time.Time
	}
	var files []entry
	for _, path := range matches {
		if info, err := os.Stat(path); err == nil {
			files = append(files, entry{path, info.ModTime()})
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.Before(files[j].mod) })
	for len(files) > keepPastes {
		_ = os.Remove(files[0].path)
		files = files[1:]
	}
}

// store guarda un PNG ya hecho en la carpeta de pegados.
func store(dir string, data []byte) (string, string) {
	target := newPath(dir)
	if err := os.WriteFile(target, data, 0o600); err != nil {
		return "", fmt.Sprintf("no se pudo guardar la imagen (%v)", err)
	}
	prune(dir)
	return target, ""
}

// Paste guarda la imagen del portapapeles y devuelve su ruta, o un mensaje de
// error legible. Nunca falla con pánico: pegar es un atajo y no puede tumbar
// la interfaz.
func Paste(home string) (path, problem string) {
	defer func() {
		if r := recover(); r != nil {
			path, problem = "", fmt.Sprintf("no se pudo pegar la imagen (%v)", r)
		}
	}()
	dir, err := pasteDir(home)
	if err != nil {
		return "", fmt.Sprintf("no se pudo pegar la imagen (%v)", err)
	}
	return readImage(dir)
}

// DIBToPNG convierte el CF_DIB del portapapeles de Windows a PNG. Solo 24 y 32
// bits sin comprimir, que es lo que dejan las capturas de pantalla y los
// editores de imagen. El canal alfa SE DESCARTA a propósito: muchas apps copian
// 32 bits con alfa a cero y un PNG RGBA salido de ahí se vería transparente.
func DIBToPNG(dib []byte) ([]byte, bool) {
	if len(dib) < 40 {
		return nil, false
	}
	headerSize := binary.LittleEndian.Uint32(dib[0:])
	width := int(int32(binary.LittleEndian.Uint32(dib[4:])))
	height := int(int32(binary.LittleEndian.Uint32(dib[8:])))
	bits := int(binary.LittleEndian.Uint16(dib[14:]))
	compression := binary.LittleEndian.Uint32(dib[16:])
	if headerSize < 40 || (bits != 24 && bits != 32) || (compression != 0 && compression != 3) {
		return nil, false
	}
	offset := int64(headerSize) + int64(binary.LittleEndian.Uint32(dib[32:]))*4
	if compression == 3 && headerSize == 40 {
		offset += 12
	}
	bottomUp := height > 0
	if height < 0 {
		height = -height
	}
	if width <= 0 || height <= 0 || width > 1<<15 || height > 1<<15 {
		return nil, false
	}
	stride := int64((width*bits+31)/32) * 4
	if int64(len(dib)) < offset+stride*int64(height) {
		return nil, false
	}

	step := bits / 8
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		row := y
		if bottomUp {
			row = height - 1 - y
		}
		line := dib[offset+int64(row)*stride:]
		for x := 0; x < width; x++ {
			px := line[x*step:]
			img.SetRGBA(x, y, color.RGBA{R: px[2], G: px[1], B: px[0], A: 0xff})
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		return nil, false
	}
	return out.Bytes(), true
}

func isPNG(data []byte) bool { return bytes.HasPrefix(data, pngSignature) }

type helper struct {
	name string
	args []string
}

// helpers son las herramientas del sistema que pueden dar la imagen del
// portapapeles en Linux y macOS.
var helpers = []helper{
	{"wl-paste", []string{"--no-newline", "--type", "image/png"}},
	{"xclip", []string{"-selection", "clipboard", "-t", "image/png", "-o"}},
	{"pngpaste", []string{"-"}},
}

func fromHelpers(dir string, lookPath func(string) (string, error), run func(string, ...string) ([]byte, error)) (string, string) {
	missing := true
	for _, h := range helpers {
		if _, err := lookPath(h.name); err != nil {
			continue
		}
		missing = false
		if out, err := run(h.name, h.args...); err == nil && isPNG(out) {
			return store(dir, out)
		}
	}
	if missing {
		return "", "instala wl-clipboard, xclip o pngpaste para pegar imágenes"
	}
	return "", "el portapapeles no tiene ninguna imagen"
}
