[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

function Invoke-ProjectCommand {
  param([string]$Path, [string[]]$Command)
  Push-Location (Join-Path $projectRoot $Path)
  try {
    & $Command[0] $Command[1..($Command.Length - 1)]
    if ($LASTEXITCODE -ne 0) { throw "Falló: $($Command -join ' ') en $Path" }
  } finally {
    Pop-Location
  }
}

Invoke-ProjectCommand 'backend' @('npm', 'run', 'typecheck')
Invoke-ProjectCommand 'backend' @('npm', 'test')
Invoke-ProjectCommand 'frontend' @('npm', 'test')
Invoke-ProjectCommand 'frontend' @('npm', 'run', 'build')

Invoke-ProjectCommand 'extension' @('npm', 'test')
Invoke-ProjectCommand 'extension' @('npm', 'run', 'check')

Write-Host 'Validación completa finalizada correctamente.' -ForegroundColor Green
