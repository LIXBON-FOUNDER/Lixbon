// Package update descarga, verifica e instala la última versión del binario.
//
// La confianza se reparte en dos orígenes: el gateway publica la versión y el
// digest de cada archivo, y los bytes y el SHA256SUMS salen de la release de
// GitHub. Solo se instala si los dos digests coinciden con el archivo.
package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"lixbon.com/cli/internal/config"
)

const (
	Channel        = "beta"
	maxManifest    = 1 << 20
	maxArchive     = 200 << 20
	maxBinary      = 200 << 20
	verifyTimeout  = 15 * time.Second
	oldSuffix      = ".old"
	sumsFileName   = "SHA256SUMS"
	binaryBaseName = "lixbon"
)

type manifestAsset struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}

type manifest struct {
	Version string                   `json:"version"`
	Channel string                   `json:"channel"`
	Assets  map[string]manifestAsset `json:"assets"`
}

type Release struct {
	Version string
	URL     string
	SHA256  string
	Newer   bool
}

type Updater struct {
	HTTP        *http.Client
	ManifestURL string
	Current     string
	GOOS        string
	GOARCH      string
	Exe         string
	// Verify comprueba el binario nuevo antes de instalarlo; nil lo omite.
	Verify func(ctx context.Context, path, version string) error
}

// ManifestURLFor deriva la URL del manifest del gateway desde la base de la
// API (https://lixbon.com/v1 → https://lixbon.com/api/updates/cli/beta).
func ManifestURLFor(baseURL string) string {
	base := strings.TrimRight(baseURL, "/")
	base = strings.TrimSuffix(base, "/v1")
	return base + "/api/updates/cli/" + Channel
}

func New(manifestURL string) (*Updater, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("no se pudo localizar el ejecutable: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return &Updater{
		HTTP:        &http.Client{},
		ManifestURL: manifestURL,
		Current:     config.Version,
		GOOS:        runtime.GOOS,
		GOARCH:      runtime.GOARCH,
		Exe:         exe,
		Verify:      verifyBinary,
	}, nil
}

func (u *Updater) platform() string { return u.GOOS + "-" + u.GOARCH }

func (u *Updater) binaryName() string {
	if u.GOOS == "windows" {
		return binaryBaseName + ".exe"
	}
	return binaryBaseName
}

func secureURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return fmt.Errorf("URL inválida %q", raw)
	}
	host := parsed.Hostname()
	local := host == "localhost" || host == "127.0.0.1" || host == "::1"
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && local) {
		return fmt.Errorf("por seguridad la actualización exige HTTPS (%s)", raw)
	}
	return nil
}

func (u *Updater) get(ctx context.Context, rawURL string) (*http.Response, error) {
	if err := secureURL(rawURL); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", config.UserAgent)
	resp, err := u.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("%s respondió %d", rawURL, resp.StatusCode)
	}
	return resp, nil
}

// Check consulta el gateway y devuelve la release para esta plataforma.
func (u *Updater) Check(ctx context.Context) (Release, error) {
	resp, err := u.get(ctx, u.ManifestURL)
	if err != nil {
		return Release{}, fmt.Errorf("no se pudo consultar la versión más reciente: %w", err)
	}
	defer resp.Body.Close()
	var m manifest
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxManifest)).Decode(&m); err != nil {
		return Release{}, fmt.Errorf("el gateway devolvió un manifest ilegible: %w", err)
	}
	asset, ok := m.Assets[u.platform()]
	if !ok || asset.URL == "" {
		return Release{}, fmt.Errorf("no hay binario publicado para %s", u.platform())
	}
	if !validDigest(asset.SHA256) {
		return Release{}, fmt.Errorf("el manifest no trae un SHA-256 válido para %s", u.platform())
	}
	order, err := compareVersions(m.Version, u.Current)
	if err != nil {
		return Release{}, err
	}
	return Release{Version: m.Version, URL: asset.URL, SHA256: strings.ToLower(asset.SHA256), Newer: order > 0}, nil
}

func validDigest(digest string) bool {
	if len(digest) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(digest)
	return err == nil
}

// Apply instala la release. Si algo falla antes del reemplazo, el binario
// actual no se toca; si falla el reemplazo, se restaura.
func (u *Updater) Apply(ctx context.Context, rel Release) error {
	dir := filepath.Dir(u.Exe)
	staged, err := os.CreateTemp(dir, ".lixbon-update-*")
	if err != nil {
		return fmt.Errorf("no hay permiso para escribir en %s: %w", dir, err)
	}
	stagedPath := staged.Name()
	defer os.Remove(stagedPath)

	archive, err := u.download(ctx, rel)
	if err != nil {
		staged.Close()
		return err
	}
	if err := u.extract(archive, rel.URL, staged); err != nil {
		staged.Close()
		return err
	}
	if err := staged.Close(); err != nil {
		return err
	}
	if err := os.Chmod(stagedPath, 0o755); err != nil {
		return err
	}
	if u.Verify != nil {
		if err := u.Verify(ctx, stagedPath, rel.Version); err != nil {
			return fmt.Errorf("el binario descargado no funciona: %w", err)
		}
	}
	return u.replace(stagedPath)
}

func (u *Updater) download(ctx context.Context, rel Release) ([]byte, error) {
	resp, err := u.get(ctx, rel.URL)
	if err != nil {
		return nil, fmt.Errorf("no se pudo descargar la actualización: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxArchive+1))
	if err != nil {
		return nil, fmt.Errorf("se cortó la descarga: %w", err)
	}
	if len(data) > maxArchive {
		return nil, errors.New("el archivo descargado supera el tamaño máximo")
	}
	sum := sha256.Sum256(data)
	actual := hex.EncodeToString(sum[:])
	if actual != rel.SHA256 {
		return nil, fmt.Errorf("el SHA-256 del archivo (%s) no coincide con el del gateway; no se instala", actual)
	}
	published, err := u.publishedSum(ctx, rel.URL)
	if err != nil {
		return nil, err
	}
	if published != actual {
		return nil, errors.New("el SHA-256 del archivo no coincide con SHA256SUMS de la release; no se instala")
	}
	return data, nil
}

// publishedSum lee el digest del archivo en el SHA256SUMS de la misma release.
func (u *Updater) publishedSum(ctx context.Context, assetURL string) (string, error) {
	parsed, err := url.Parse(assetURL)
	if err != nil {
		return "", err
	}
	name := path.Base(parsed.Path)
	parsed.Path = path.Join(path.Dir(parsed.Path), sumsFileName)
	resp, err := u.get(ctx, parsed.String())
	if err != nil {
		return "", fmt.Errorf("no se pudo leer %s de la release: %w", sumsFileName, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxManifest))
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(body), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == name {
			return strings.ToLower(fields[0]), nil
		}
	}
	return "", fmt.Errorf("%s no lista %s", sumsFileName, name)
}

func (u *Updater) extract(archive []byte, assetURL string, dst io.Writer) error {
	name := strings.ToLower(assetURL)
	var err error
	switch {
	case strings.HasSuffix(name, ".zip"):
		err = u.extractZip(archive, dst)
	case strings.HasSuffix(name, ".tar.gz"):
		err = u.extractTarGz(archive, dst)
	default:
		return fmt.Errorf("formato de archivo no soportado: %s", assetURL)
	}
	return err
}

func (u *Updater) extractZip(archive []byte, dst io.Writer) error {
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return fmt.Errorf("el archivo zip está dañado: %w", err)
	}
	for _, file := range reader.File {
		if file.FileInfo().IsDir() || path.Base(file.Name) != u.binaryName() {
			continue
		}
		src, err := file.Open()
		if err != nil {
			return err
		}
		defer src.Close()
		return copyBinary(dst, src)
	}
	return fmt.Errorf("el archivo no contiene %s", u.binaryName())
}

func (u *Updater) extractTarGz(archive []byte, dst io.Writer) error {
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return fmt.Errorf("el archivo tar.gz está dañado: %w", err)
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return fmt.Errorf("el archivo no contiene %s", u.binaryName())
		}
		if err != nil {
			return fmt.Errorf("el archivo tar.gz está dañado: %w", err)
		}
		if header.Typeflag == tar.TypeReg && path.Base(header.Name) == u.binaryName() {
			return copyBinary(dst, reader)
		}
	}
}

func copyBinary(dst io.Writer, src io.Reader) error {
	n, err := io.Copy(dst, io.LimitReader(src, maxBinary+1))
	if err != nil {
		return err
	}
	if n > maxBinary {
		return errors.New("el binario supera el tamaño máximo")
	}
	if n == 0 {
		return errors.New("el binario del archivo está vacío")
	}
	return nil
}

// replace sustituye el ejecutable. En Windows no se puede sobrescribir ni
// borrar un .exe en uso, pero sí renombrarlo: el actual pasa a .old (que
// CleanupOld borra en el siguiente arranque) y se restaura si falla.
func (u *Updater) replace(stagedPath string) error {
	if u.GOOS != "windows" {
		return os.Rename(stagedPath, u.Exe)
	}
	old := u.Exe + oldSuffix
	_ = os.Remove(old)
	if err := os.Rename(u.Exe, old); err != nil {
		return fmt.Errorf("no se pudo apartar el ejecutable actual: %w", err)
	}
	if err := os.Rename(stagedPath, u.Exe); err != nil {
		if restoreErr := os.Rename(old, u.Exe); restoreErr != nil {
			return fmt.Errorf("falló la instalación (%v) y no se pudo restaurar %s: %w", err, old, restoreErr)
		}
		return fmt.Errorf("no se pudo instalar la nueva versión: %w", err)
	}
	_ = os.Remove(old)
	return nil
}

// CleanupOld borra el ejecutable apartado por una actualización anterior.
func CleanupOld() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	_ = os.Remove(exe + oldSuffix)
}

func verifyBinary(ctx context.Context, binary, version string) error {
	ctx, cancel := context.WithTimeout(ctx, verifyTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, binary, "status").Output()
	if err != nil {
		return err
	}
	if want := "lixbon CLI v" + version; !strings.Contains(string(out), want) {
		return fmt.Errorf("no informa la versión esperada (%s)", want)
	}
	return nil
}

// ManifestURLForConfig usa el gateway del perfil activo y, con un proveedor
// genérico (que no publica binarios), el gateway por defecto.
func ManifestURLForConfig(cfg config.Config) string {
	if override := os.Getenv("LIXBON_UPDATE_URL"); override != "" {
		return override
	}
	if cfg.IsGeneric() || cfg.BaseURL == "" {
		return ManifestURLFor(config.DefaultBaseURL)
	}
	return ManifestURLFor(cfg.BaseURL)
}

// Run comprueba si hay una versión nueva y, salvo checkOnly, la instala. Devuelve
// el mensaje para el usuario.
func Run(ctx context.Context, u *Updater, checkOnly bool) (string, error) {
	rel, err := u.Check(ctx)
	if err != nil {
		return "", err
	}
	if !rel.Newer {
		return fmt.Sprintf("lixbon ya está actualizado (v%s).", u.Current), nil
	}
	if checkOnly {
		return fmt.Sprintf("Hay una versión nueva: v%s (instalada: v%s). Ejecuta «lixbon update».", rel.Version, u.Current), nil
	}
	if err := u.Apply(ctx, rel); err != nil {
		return "", err
	}
	return fmt.Sprintf("Actualizado de v%s a v%s. Vuelve a abrir lixbon para usar la nueva versión.", u.Current, rel.Version), nil
}
