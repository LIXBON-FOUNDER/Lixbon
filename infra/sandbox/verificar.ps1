# Pruebas de aislamiento dentro del entorno de una sesión de Coding.
# Uso: .\infra\sandbox\verificar.ps1 <id de sesión (12 hex)>
param([Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{12}$')][string]$Sesion)
$dockerBin = 'C:\Program Files\Docker\Docker\resources\bin'
if (Test-Path $dockerBin) { $env:PATH = "$dockerBin;$env:PATH" }
# El script va como argumento (no por stdin: PowerShell 5 le añadiría un BOM).
$script = (Get-Content -Raw -Encoding utf8 (Join-Path $PSScriptRoot 'verificar.sh')) -replace "`r", ''
docker exec "lixbon-sbx-$Sesion" sh -c $script
exit $LASTEXITCODE
