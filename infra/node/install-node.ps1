# Instalador de un nodo GPU de Lixbon (Windows). Lo sirve el gateway en /install-node.ps1:
#   $env:LIXBON_ENROLL="<token>"; irm https://lixbon.com/install-node.ps1 | iex
# Descarga solo agent.py, instala Python/Ollama si faltan y deja el agente
# arrancando al iniciar sesión (Task Scheduler, sin admin). No hace falta el repo.
$ErrorActionPreference = "Stop"

$Gateway = if ($env:LIXBON_GATEWAY) { $env:LIXBON_GATEWAY } else { "__GATEWAY__" }
$Dir = Join-Path $env:LOCALAPPDATA "Lixbon\node"
$Task = "Lixbon Node Agent"
# Sin token pero con un nodo ya enrolado: es una actualizacion (agente, tarea,
# lanzador); la identidad y el node.env se conservan.
$Actualizar = (-not $env:LIXBON_ENROLL) -and (Test-Path (Join-Path $Dir "node.json"))
if (-not $env:LIXBON_ENROLL -and -not $Actualizar) {
  Write-Host "Falta LIXBON_ENROLL: genera un token en el panel admin (Nodos -> Anadir GPU)" -ForegroundColor Red
  Write-Host '  $env:LIXBON_ENROLL="<token>"; irm ' + $Gateway + '/install-node.ps1 | iex'
  return
}
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

# Flash attention + KV q8_0: la mitad de VRAM por token de contexto (ventanas grandes).
# Variables de usuario: la app de Ollama las lee al arrancar, por eso se reinicia.
[Environment]::SetEnvironmentVariable("OLLAMA_FLASH_ATTENTION", "1", "User")
[Environment]::SetEnvironmentVariable("OLLAMA_KV_CACHE_TYPE", "q8_0", "User")
if (-not [Environment]::GetEnvironmentVariable("OLLAMA_CONTEXT_LENGTH", "User")) {
  [Environment]::SetEnvironmentVariable("OLLAMA_CONTEXT_LENGTH", "32768", "User")
}
$ollamaApp = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama app.exe"
if (Get-Process -Name "ollama app" -ErrorAction SilentlyContinue) {
  Stop-Process -Name "ollama app" -Force -ErrorAction SilentlyContinue
  Stop-Process -Name "ollama" -Force -ErrorAction SilentlyContinue
  Start-Sleep 2
  if (Test-Path $ollamaApp) { Start-Process $ollamaApp }
}

Write-Host "> Dependencias de Python..."
python -m pip install --quiet --user "httpx>=0.27" psutil "websockets>=13" fastapi

Write-Host "> Descargando el agente..."
Invoke-WebRequest -UseBasicParsing "$Gateway/node-agent.py" -OutFile (Join-Path $Dir "agent.py")

if (-not $Actualizar) {
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
}

# run.ps1 carga node.env y SUPERVISA al agente: es lo que ejecuta la tarea
# programada. Al iniciar sesion, Python (alias de la Store), la red u Ollama
# pueden no estar listos y el primer arranque muere sin escribir nada; el
# bucle lo reintenta hasta que engancha. Solo se rinde si el agente pide parar
# (codigo 3: identidad invalida o nodo deshabilitado).
$run = @'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $dir "agent.log"
Get-Content (Join-Path $dir "node.env") | ForEach-Object {
  if ($_ -match "^([^=]+)=(.*)$" -and $matches[2] -ne "") { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process") }
}
Set-Location $dir
$seguidos = 0
while ($true) {
  $inicio = Get-Date
  "[run.ps1] $(Get-Date -Format s) arrancando el agente" | Add-Content $log
  $code = -1
  try {
    & python -u (Join-Path $dir "agent.py") *>> $log
    $code = $LASTEXITCODE
  } catch {
    "[run.ps1] no se pudo lanzar python: $($_.Exception.Message)" | Add-Content $log
  }
  if ($code -eq 3) { "[run.ps1] el agente pidio parar (codigo 3); revisa el log" | Add-Content $log; break }
  if (((Get-Date) - $inicio).TotalSeconds -gt 120) { $seguidos = 0 } else { $seguidos++ }
  if ($seguidos -gt 60) { "[run.ps1] 60 arranques fallidos seguidos; me rindo" | Add-Content $log; break }
  "[run.ps1] el agente termino (codigo $code); reintento en 15 s" | Add-Content $log
  Start-Sleep -Seconds 15
}
'@
Set-Content -Path (Join-Path $Dir "run.ps1") -Value $run -Encoding utf8

$args = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Dir\run.ps1`""
try {
  # schtasks /SC ONLOGON exige admin; los cmdlets registran la tarea del usuario sin elevar.
  Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$Dir*agent.py*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $args
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $trigger.Delay = "PT20S"  # que la red, Ollama y los alias de la Store esten listos
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
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
