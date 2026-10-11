package weblogin

import (
	"embed"
	"html"
	"net/http"
	"strings"
)

// Las fuentes de lixbon.com van dentro del binario: la página se sirve desde
// 127.0.0.1 y el navegador no deja cargarlas de otro origen sin CORS.
//
//go:embed fonts/*.woff2
var assets embed.FS

type tone string

const (
	toneOK   tone = "ok"
	toneWarn tone = "warn"
	toneErr  tone = "err"
)

var toneLabel = map[tone]string{
	toneOK:   "Sesión autorizada",
	toneWarn: "Cancelado",
	toneErr:  "No se pudo completar",
}

func writePage(w http.ResponseWriter, status int, t tone, title, text string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	strings.NewReplacer(
		"{title}", html.EscapeString(title),
		"{text}", html.EscapeString(text),
		"{tone}", string(t),
		"{label}", toneLabel[t],
	).WriteString(w, page)
}

// Mismo aspecto que lixbon.com/auth (apps/web/src/styles/auth.css).
const page = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · Lixbon CLI</title>
<style>
@font-face{font-family:'Geist';font-weight:300 700;font-display:swap;src:url(/fonts/geist-latin.woff2) format('woff2')}
@font-face{font-family:'Bruno Ace SC';font-display:swap;src:url(/fonts/bruno-ace-sc-latin.woff2) format('woff2')}
@font-face{font-family:'Lancelot';font-display:swap;src:url(/fonts/lancelot-latin.woff2) format('woff2')}
:root{color-scheme:dark;--bg:#0E0E0E;--card:#161616;--s3:#1C1C1C;--s4:#232323;--ink:#F2F2F0;--muted:#7C7C79;
  --label:#6E6E6C;--line:#232320;--nodo:#6E7A45;--gpu:#8CA038;
  --ok:#B4C64E;--ok-bg:rgba(140,160,56,.16);--warn:#C9A227;--warn-bg:rgba(201,162,39,.14);
  --err:#D4785F;--err-bg:rgba(196,85,61,.14);--sombra:0 32px 80px rgba(0,0,0,.55)}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#F5F4EE;--card:#FBFAF6;--s3:#ECEAE1;--s4:#E3E1D7;
  --ink:#191917;--muted:#8A8A82;--label:#8A8A82;--line:#CFCBBB;--nodo:#A3B068;--gpu:#7E9430;
  --ok:#6A7D28;--ok-bg:rgba(126,148,48,.14);--warn:#A8842A;--warn-bg:rgba(168,132,42,.14);
  --err:#A33D28;--err-bg:rgba(184,70,47,.12);--sombra:0 30px 70px -20px rgba(60,52,30,.22)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:40px 16px;
  background:var(--bg);color:var(--ink);font:14px/1.5 'Geist','Segoe UI',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.cluster{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}
.cluster line{stroke:var(--line)}
.cluster circle{fill:var(--nodo);animation:latido 7s ease-in-out infinite}
.cluster .gpu{fill:var(--gpu)}
@keyframes latido{0%,100%{opacity:.38}50%{opacity:.72}}
.panel{position:relative;width:400px;max-width:100%;animation:entra .36s cubic-bezier(.32,.72,0,1)}
@keyframes entra{from{opacity:0;transform:translateY(14px)}}
.tab{display:block;width:104px;height:12px;margin-left:34px;border-radius:6px 6px 0 0;background:var(--card)}
main{display:flex;flex-direction:column;align-items:center;gap:18px;padding:32px 32px 28px;border-radius:6px;
  background:var(--card);box-shadow:var(--sombra);text-align:center}
.logo{display:inline-flex;align-items:center;gap:9px}
.brand{font:20px/1 'Bruno Ace SC','Geist',sans-serif;letter-spacing:.02em;position:relative;top:.05em}
.estado{display:inline-flex;align-items:center;gap:8px;padding:5px 12px;border-radius:6px;font-size:12.5px;
  color:var(--{tone});background:var(--{tone}-bg)}
.estado::before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor}
h1{margin:0;font:400 32px/1.1 'Lancelot','Iowan Old Style',Georgia,serif}
p{margin:-4px 0 0;color:var(--muted);font-size:13.5px;text-wrap:pretty}
.pie{margin:4px 0 0;padding-top:16px;width:100%;border-top:1px solid var(--s4);font-size:11.5px;color:var(--label)}
@media (prefers-reduced-motion:reduce){.panel,.cluster circle{animation:none}}
</style></head><body>
<svg class="cluster" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
<line x1="130" y1="180" x2="300" y2="300"/><line x1="300" y1="300" x2="170" y2="520"/><line x1="170" y1="520" x2="340" y2="660"/>
<line x1="340" y1="660" x2="120" y2="790"/><line x1="130" y1="180" x2="170" y2="520"/><line x1="300" y1="300" x2="340" y2="660"/>
<line x1="700" y1="90" x2="300" y2="300"/><line x1="700" y1="90" x2="1120" y2="160"/><line x1="1120" y1="160" x2="1300" y2="290"/>
<line x1="1300" y1="290" x2="1150" y2="500"/><line x1="1150" y1="500" x2="1290" y2="690"/><line x1="1290" y1="690" x2="1110" y2="810"/>
<line x1="1120" y1="160" x2="1150" y2="500"/><line x1="1150" y1="500" x2="1110" y2="810"/><line x1="740" y1="830" x2="340" y2="660"/>
<line x1="740" y1="830" x2="1290" y2="690"/>
<circle cx="130" cy="180" r="3.5"/><circle class="gpu" cx="300" cy="300" r="6" style="animation-delay:-.9s"/>
<circle cx="170" cy="520" r="3.5" style="animation-delay:-1.8s"/><circle cx="340" cy="660" r="3.5" style="animation-delay:-2.7s"/>
<circle cx="120" cy="790" r="3.5" style="animation-delay:-3.6s"/><circle cx="1120" cy="160" r="3.5" style="animation-delay:-4.5s"/>
<circle cx="1300" cy="290" r="3.5" style="animation-delay:-5.4s"/><circle class="gpu" cx="1150" cy="500" r="6" style="animation-delay:-6.3s"/>
<circle cx="1290" cy="690" r="3.5" style="animation-delay:-7.2s"/><circle cx="1110" cy="810" r="3.5" style="animation-delay:-8.1s"/>
<circle cx="700" cy="90" r="3.5" style="animation-delay:-9s"/><circle cx="740" cy="830" r="3.5" style="animation-delay:-9.9s"/>
</svg>
<div class="panel"><span class="tab" aria-hidden="true"></span><main>
<span class="logo"><svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true">
<rect width="32" height="32" rx="9" fill="#1B1A17"/>
<g stroke="#1B1A17" stroke-width=".9" stroke-linejoin="round">
<polygon points="16,3.2 3.2,16 16,16" fill="#DCD6BC"/><polygon points="16,3.2 28.8,16 16,16" fill="#C7BE9F"/>
<polygon points="3.2,16 16,28.8 16,16" fill="#4B5327"/><polygon points="28.8,16 16,28.8 16,16" fill="#333A1C"/></g>
<path d="M19.8 16C20.956 18.244 20.956 18.244 23.2 19.4C20.956 20.556 20.956 20.556 19.8 22.8C18.644 20.556 18.644 20.556 16.4 19.4C18.644 18.244 18.644 18.244 19.8 16Z" fill="#FCFAEF"/>
<circle cx="23.4" cy="22.6" r="1.1" fill="#FCFAEF"/></svg><span class="brand">LIXBON</span></span>
<span class="estado">{label}</span>
<h1>{title}</h1>
<p>{text}</p>
<div class="pie">Lixbon CLI · lixbon.com</div>
</main></div></body></html>`
