# Construye lo necesario para las sesiones de Coding en local:
#   - el CLI de Lixbon para linux/amd64 (va dentro de la imagen),
#   - la imagen del entorno (lixbon-sandbox),
#   - los proxies de salida (lixbon-egress) y de entrada (lixbon-ingress).
# Requiere Go y Docker Desktop arrancado. Uso: .\infra\scripts\sandbox-build.ps1
# (docker escribe su progreso en stderr: se comprueba $LASTEXITCODE, no excepciones)
$ErrorActionPreference = 'Continue'
$raiz = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$dockerBin = 'C:\Program Files\Docker\Docker\resources\bin'
if ((Test-Path $dockerBin) -and -not ($env:PATH -split ';' -contains $dockerBin)) { $env:PATH = "$dockerBin;$env:PATH" }

function Paso($nombre, [scriptblock]$accion) {
  Write-Host "== $nombre"
  & $accion 2>&1 | ForEach-Object { "$_" } | Select-Object -Last 3 | ForEach-Object { Write-Host "   $_" }
  if ($LASTEXITCODE -ne 0) { Write-Error "$nombre falló (código $LASTEXITCODE)"; exit 1 }
}

docker info --format '{{.ServerVersion}}' *> $null
if ($LASTEXITCODE -ne 0) { Write-Error 'Docker no responde: abre Docker Desktop y vuelve a intentarlo.'; exit 1 }

$bin = Join-Path $raiz 'infra\sandbox\bin'
New-Item -ItemType Directory -Force $bin | Out-Null
Push-Location (Join-Path $raiz 'apps\cli')
try {
  $env:GOOS = 'linux'; $env:GOARCH = 'amd64'; $env:CGO_ENABLED = '0'
  Paso 'CLI linux/amd64' { go build -trimpath -ldflags '-s -w' -o (Join-Path $bin 'lixbon') ./cmd/lixbon }
} finally {
  Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED -ErrorAction SilentlyContinue
  Pop-Location
}

Paso 'lixbon-egress' { docker build -t lixbon-egress (Join-Path $raiz 'infra\sandbox\egress') }
Paso 'lixbon-ingress' { docker build -t lixbon-ingress (Join-Path $raiz 'infra\sandbox\ingress') }
Paso 'lixbon-sandbox' { docker build -t lixbon-sandbox (Join-Path $raiz 'infra\sandbox') }
Write-Host 'Listo: lixbon-sandbox, lixbon-egress y lixbon-ingress.'
