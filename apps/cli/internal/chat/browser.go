package chat

import (
	"os"
	"path/filepath"
	"runtime"

	"lixbon.com/cli/internal/browser"
	"lixbon.com/cli/internal/config"
)

// browserMode lee la clave browser de la config: auto (por defecto), on u off.
func browserMode(cfg config.Config) string {
	switch mode := cfg.ExtraString("browser"); mode {
	case "on", "off":
		return mode
	}
	if v, ok := cfg.Extra["browser"]; ok && string(v) == "false" {
		return "off"
	}
	return "auto"
}

// setupBrowser prepara el navegador del agente sin abrirlo: se lanza con la
// primera página que pida. Sin navegador instalado queda desactivado.
func (c *Chat) setupBrowser(configPath string) {
	c.Session.BrowserMode = browserMode(c.Cfg)
	c.Session.AutoBrowser = c.Cfg.ExtraBool("browser_auto_approve", false)
	if c.Session.BrowserMode == "off" {
		return
	}
	exe, err := browser.FindExecutable(browser.SystemEnv(), c.Cfg.ExtraString("browser_path"))
	if err != nil {
		c.BrowserErr = err
		return
	}
	dir := filepath.Dir(configPath)
	if configPath == "" {
		dir, _ = config.DefaultDir()
	}
	home, _ := os.UserHomeDir()
	headless := c.Cfg.ExtraBool("browser_headless", false) || os.Getenv("LIXBON_BROWSER_HEADLESS") == "1" ||
		(runtime.GOOS == "linux" && os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "")
	c.Browser = browser.New(browser.Options{
		Executable: exe,
		ProfileDir: browser.ProfileDir(dir, exe, home),
		Headless:   headless,
		KeepOpen:   c.Cfg.ExtraBool("browser_keep_open", false),
	})
	c.Toolbox.Browser = c.Browser
}

// SetBrowserMode cambia el modo para esta sesión y lo guarda en la config.
func (c *Chat) SetBrowserMode(mode string) error {
	c.Session.BrowserMode = mode
	if mode == "off" && c.Browser != nil {
		c.Browser.Close()
	}
	if mode != "off" && c.Browser == nil && c.BrowserErr == nil {
		c.setupBrowser(c.ConfigPath)
		c.Session.BrowserMode = mode
	}
	c.Cfg.SetExtraString("browser", mode)
	return c.SaveConfig()
}
