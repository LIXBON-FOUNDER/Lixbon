package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Lo que el agente hace como con las DevTools: ver la página a otro tamaño y
// ejecutar JavaScript. La ventana se abre siempre maximizada.

const evalResultMax = 4000

type viewportPreset struct {
	width, height int
	scale         float64
	mobile        bool
	label         string
}

var viewportPresets = map[string]viewportPreset{
	"mobile":  {390, 844, 3, true, "móvil"},
	"tablet":  {820, 1180, 2, true, "tableta"},
	"desktop": {1440, 900, 1, false, "escritorio"},
}

// maximize pone la ventana del navegador maximizada la primera vez que se
// usa en esta conexión: al lanzarlo ya lo está, pero uno abierto de antes
// puede haber quedado pequeño.
func (m *Manager) maximize(ctx context.Context, targetID string) {
	if m.maximized || m.opts.Headless {
		return
	}
	m.maximized = true
	var w struct {
		WindowID int `json:"windowId"`
	}
	if m.conn.call(ctx, "", "Browser.getWindowForTarget", map[string]any{"targetId": targetID}, &w) != nil {
		return
	}
	_ = m.conn.call(ctx, "", "Browser.setWindowBounds", map[string]any{
		"windowId": w.WindowID, "bounds": map[string]any{"windowState": "maximized"},
	}, nil)
}

// viewport cambia el tamaño con el que se pinta la página de la pestaña en
// curso, como el modo dispositivo de las DevTools; reset vuelve al de la
// ventana.
func (m *Manager) viewport(ctx context.Context, preset string, width, height int, mobile bool) (string, error) {
	t, err := m.page(ctx, false)
	if err != nil {
		return "", err
	}
	preset = strings.ToLower(strings.TrimSpace(preset))
	if preset == "reset" {
		if err := m.conn.call(ctx, t.sessionID, "Emulation.clearDeviceMetricsOverride", nil, nil); err != nil {
			return "", err
		}
		_ = m.conn.call(ctx, t.sessionID, "Emulation.setTouchEmulationEnabled", map[string]any{"enabled": false}, nil)
		return "La página vuelve al tamaño de la ventana.", nil
	}
	p, ok := viewportPresets[preset]
	switch {
	case ok:
	case preset != "":
		return "", fmt.Errorf("preajuste desconocido «%s»: usa mobile, tablet, desktop o reset", preset)
	case width < 200 || height < 200 || width > 4000 || height > 4000:
		return "", errors.New("indica un preajuste, o un ancho y un alto entre 200 y 4000 px")
	default:
		p = viewportPreset{width, height, 1, mobile, "personalizado"}
		if mobile {
			p.scale = 2
		}
	}
	err = m.conn.call(ctx, t.sessionID, "Emulation.setDeviceMetricsOverride", map[string]any{
		"width": p.width, "height": p.height, "deviceScaleFactor": p.scale, "mobile": p.mobile,
	}, nil)
	if err != nil {
		return "", err
	}
	_ = m.conn.call(ctx, t.sessionID, "Emulation.setTouchEmulationEnabled", map[string]any{"enabled": p.mobile}, nil)
	return fmt.Sprintf("La página se ve ahora a %d×%d (%s). Revísala con browser_screenshot o browser_snapshot; "+
		`browser_viewport {"preset":"reset"} vuelve al tamaño de la ventana.`, p.width, p.height, p.label), nil
}

// eval ejecuta JavaScript en el mundo de la página (el de la consola, con
// sus variables) y devuelve el resultado en JSON.
func (m *Manager) eval(ctx context.Context, expression string) (string, error) {
	if strings.TrimSpace(expression) == "" {
		return "", errors.New("falta expression")
	}
	t, err := m.page(ctx, false)
	if err != nil {
		return "", err
	}
	var res struct {
		Result           remoteObject `json:"result"`
		ExceptionDetails *struct {
			Text      string        `json:"text"`
			Exception *remoteObject `json:"exception"`
		} `json:"exceptionDetails"`
	}
	err = m.conn.call(ctx, t.sessionID, "Runtime.evaluate", map[string]any{
		"expression": expression, "returnByValue": true, "awaitPromise": true, "replMode": true,
		"userGesture": true, "timeout": 10000,
	}, &res)
	if err != nil {
		return "", err
	}
	if d := res.ExceptionDetails; d != nil {
		msg := d.Text
		if d.Exception != nil && d.Exception.Description != "" {
			msg, _, _ = strings.Cut(d.Exception.Description, "\n")
		}
		return "", errors.New(msg)
	}
	out := res.Result.String()
	if len(res.Result.Value) > 0 {
		var pretty any
		if json.Unmarshal(res.Result.Value, &pretty) == nil {
			if b, err := json.Marshal(pretty); err == nil {
				out = string(b)
			}
		}
	}
	if out == "" {
		out = "undefined"
	}
	if utf8.RuneCountInString(out) > evalResultMax {
		out = string([]rune(out)[:evalResultMax]) + fmt.Sprintf("… (recortado a %d caracteres)", evalResultMax)
	}
	// El resultado viene de la página: va delimitado como cualquier contenido suyo.
	return strings.Join([]string{"Resultado:", PageOpen, sanitize(out), PageClose}, "\n"), nil
}
