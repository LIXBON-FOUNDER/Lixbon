# Instalador de un nodo GPU de Lixbon (Windows). Lo sirve el gateway en /install-node.ps1:
#   $env:LIXBON_ENROLL="<token>"; irm https://lixbon.com/install-node.ps1 | iex
# Descarga solo agent.py, instala Python/Ollama si faltan y deja el agente
# arrancando al iniciar sesión (Task Scheduler, sin admin). No hace falta el repo.
$ErrorActionPreference = "Stop"

$Gateway = if ($env:LIXBON_GATEWAY) { $env:LIXBON_GATEWAY } else { "__GATEWAY__" }
if (-not $env:LIXBON_ENROLL) {
  Write-Host "Falta LIXBON_ENROLL: genera un token en el panel admin (Nodos -> Anadir GPU)" -ForegroundColor Red
  Write-Host '  $env:LIXBON_ENROLL="<token>"; irm ' + $Gateway + '/install-node.ps1 | iex'
  return
}

$Dir = Join-Path $env:LOCALAPPDATA "Lixbon\node"
$Task = "Lixbon Node Agent"
New-Item -ItemType Directory -Force $Dir | Out-Null
Write-Host "> Lixbon node - gateway: $Gateway"

function Test-Cmd($n) { $null -ne (Get-Command $n -ErrorAction SilentlyContinue) }

if (-not (Test-Cmd python)) {
  Write-Host "> Instalando Python..."
  winget install --id Python.Python.3.12 -e --silent --accept-package-agreements --accept-source-agreements
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}
if (-not (Test-Cmd ollama)) {
  Write-Host "> Instalando Ollama..."
  winget install --id Ollama.Ollama -e --silent --accept-package-agreements --accept-source-agreements
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

Write-Host "> Dependencias de Python..."
python -m pip install --quiet --user "httpx>=0.27" psutil "websockets>=13" fastapi

Write-Host "> Descargando el agente..."
Invoke-WebRequest -UseBasicParsing "$Gateway/node-agent.py" -OutFile (Join-Path $Dir "agent.py")

$envLines = @(
  "LIXBON_GATEWAY=$Gateway",
  "LIXBON_ENROLL=$($env:LIXBON_ENROLL)",
  "LIXBON_STATE_FILE=$(Join-Path $Dir 'node.json')",
  "LIXBON_NODE_NAME=$($env:LIXBON_NODE_NAME)",
  "LIXBON_NODE_ID=$($env:LIXBON_NODE_ID)",
  "LIXBON_PROVIDER=$($env:LIXBON_PROVIDER)",
  "LIXBON_MODELS=$($env:LIXBON_MODELS)"
)
Set-Content -Path (Join-Path $Dir "node.env") -Value $envLines -Encoding utf8

# run.ps1 carga node.env y lanza el agente; es lo que ejecuta la tarea programada.
$run = @'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Get-Content (Join-Path $dir "node.env") | ForEach-Object {
  if ($_ -match "^([^=]+)=(.*)$" -and $matches[2] -ne "") { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process") }
}
Set-Location $dir
python -u (Join-Path $dir "agent.py") *>> (Join-Path $dir "agent.log")
'@
Set-Content -Path (Join-Path $Dir "run.ps1") -Value $run -Encoding utf8

$args = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Dir\run.ps1`""
try {
  # schtasks /SC ONLOGON exige admin; los cmdlets registran la tarea del usuario sin elevar.
  Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $args
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Settings $settings -Force -ErrorAction Stop | Out-Null
  Start-ScheduledTask -TaskName $Task
  Write-Host "OK. El agente corre en segundo plano y arranca solo al iniciar sesion." -ForegroundColor Green
  Write-Host "   Log: $Dir\agent.log   Parar: Stop-ScheduledTask '$Task'   Quitar: Unregister-ScheduledTask '$Task'"
} catch {
  Write-Host "No se pudo crear la tarea programada ($($_.Exception.Message)); se lanza el agente en segundo plano." -ForegroundColor Yellow
  Start-Process powershell.exe -ArgumentList $args -WindowStyle Hidden
  Write-Host "OK. Para que arranque solo al iniciar sesion, vuelve a ejecutar este instalador como administrador." -ForegroundColor Green
  Write-Host "   Log: $Dir\agent.log"
}
