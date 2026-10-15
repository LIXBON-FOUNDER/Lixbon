package browser

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
)

var schemePrefix = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9+.-]*):`)

// NormalizeURL completa el esquema y solo deja http, https y about:blank:
// file: saltaría el sandbox del workspace y chrome:, javascript:, data:… no
// son páginas que el agente deba abrir.
func NormalizeURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("falta url")
	}
	if strings.EqualFold(raw, "about:blank") {
		return "about:blank", nil
	}
	if !strings.Contains(raw, "://") {
		if m := schemePrefix.FindStringSubmatch(raw); m != nil && !isPortStart(raw[len(m[0]):]) {
			return "", fmt.Errorf("esquema no permitido: %s: (solo http y https)", strings.ToLower(m[1]))
		}
		scheme := "https://"
		if isLoopbackHost(hostOf(raw)) {
			scheme = "http://"
		}
		raw = scheme + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("url inválida: %v", err)
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
	default:
		return "", fmt.Errorf("esquema no permitido: %s: (solo http y https)", u.Scheme)
	}
	if u.Host == "" {
		return "", errors.New("url sin dominio")
	}
	return u.String(), nil
}

func isPortStart(rest string) bool {
	return rest != "" && rest[0] >= '0' && rest[0] <= '9'
}

func hostOf(raw string) string {
	host := raw
	if i := strings.IndexAny(host, "/?#"); i >= 0 {
		host = host[:i]
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		return h
	}
	return strings.Trim(host, "[]")
}

// Origin es esquema://host[:puerto] en minúsculas; "" para about:blank y
// páginas internas.
func Origin(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return ""
	}
	return scheme + "://" + strings.ToLower(u.Host)
}

// IsLoopback: el servidor de desarrollo del usuario. Nadie de fuera recibe
// datos ahí, así que navegar o actuar en él no pide permiso.
func IsLoopback(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return isLoopbackHost(u.Hostname())
}

func isLoopbackHost(host string) bool {
	host = strings.ToLower(host)
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

type originKey struct{}

// WithOrigin fija el origen que el usuario aprobó: si al ir a actuar la
// pestaña ya está en otro, la acción no se hace.
func WithOrigin(ctx context.Context, origin string) context.Context {
	return context.WithValue(ctx, originKey{}, origin)
}

func expectedOrigin(ctx context.Context) (string, bool) {
	o, ok := ctx.Value(originKey{}).(string)
	return o, ok
}
