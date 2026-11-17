package tools

import (
	"context"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

// ShownPreview es la app en marcha que el agente abre para el usuario en el
// panel de vista previa de una sesión de Coding.
type ShownPreview struct {
	Port int
	Path string
}

// PreviewBase es la ruta base con la que arrancar el servidor de desarrollo
// para que la vista previa lo sirva entero (Vite --base, Next basePath…).
// Vacía fuera de una sesión de Coding.
func PreviewBase(port int) string {
	base := os.Getenv("LIXBON_PREVIEW_BASE")
	if base == "" {
		return ""
	}
	return strings.ReplaceAll(base, "{port}", strconv.Itoa(port))
}

// showPreview comprueba que algo escucha en el puerto y avisa a la interfaz
// para que abra el panel. Solo existe en sesiones de Coding (OnPreview).
func (tb *Toolbox) showPreview(ctx context.Context, args map[string]any) (string, error) {
	if tb.OnPreview == nil {
		return "[ERROR] show_preview solo funciona en una sesión de Coding en la nube", nil
	}
	port, err := intArg(args, "port")
	if err != nil {
		return "", err
	}
	if port < 1024 || port > 65535 || port == 7000 {
		return "[ERROR] Puerto no válido: usa el del servidor de desarrollo (1024–65535, no el 7000)", nil
	}
	path, _ := textArg(args, "path", "/")
	path = "/" + strings.TrimLeft(strings.TrimSpace(path), "/")
	d := net.Dialer{Timeout: 2 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return fmt.Sprintf("[ERROR] Nada escucha en el puerto %d. Arranca primero el servidor de desarrollo con run_command "+
			"(en segundo plano y con la ruta base %s) y vuelve a intentarlo.", port, PreviewBase(port)), nil
	}
	conn.Close()
	tb.OnPreview(ShownPreview{Port: port, Path: path})
	return fmt.Sprintf("Vista previa abierta para el usuario en el panel derecho (puerto %d, ruta %s). "+
		"Si la página sale en blanco o sin estilos, el servidor no usa la ruta base %s: reinícialo con ella.",
		port, path, PreviewBase(port)), nil
}
