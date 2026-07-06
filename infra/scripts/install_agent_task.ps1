# Registra LIXBON Node Agent como tarea de inicio de sesión en Windows
# Resuelve las rutas dinámicamente usando el directorio actual.

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ScriptDir) { $ScriptDir = Get-Location }

$pythonPath = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
if (-not $pythonPath) {
    $pythonPath = (Get-Command python -ErrorAction SilentlyContinue).Source
}
if (-not $pythonPath) {
    $pythonPath = "python.exe"
}

$scriptPath = Join-Path $ScriptDir "app\node_agent.py"
$taskName   = "LIXBON_NodeAgent"

Write-Host "Instalando tarea para:"
Write-Host "  Python: $pythonPath"
Write-Host "  Script: $scriptPath"
Write-Host ""

$accion  = New-ScheduledTaskAction -Execute $pythonPath -Argument "`"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$config  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -Hidden

Register-ScheduledTask -TaskName $taskName -Action $accion -Trigger $trigger -Settings $config -Force

Write-Host "✓ Tarea '$taskName' registrada con éxito en Windows Task Scheduler."
Write-Host "  Se iniciará automáticamente en cada inicio de sesión de usuario."
