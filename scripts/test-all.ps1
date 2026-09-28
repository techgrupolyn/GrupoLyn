[CmdletBinding()]
param([switch]$SkipDatabaseIntegration)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (!$SkipDatabaseIntegration -and !$env:QA_TEST_DATABASE_URL) {
  throw 'Configura QA_TEST_DATABASE_URL apuntando a lyn_qa_retest en 127.0.0.1, o usa -SkipDatabaseIntegration para una revisión parcial explícita.'
}
$databaseTarget = if ($env:QA_TEST_DATABASE_URL) { $env:QA_TEST_DATABASE_URL } else { $env:DATABASE_URL }
if (!$databaseTarget) { throw 'Incluso la revisión parcial requiere una DATABASE_URL aislada para las pruebas de rutas.' }
if ($databaseTarget) {
  $target = [uri]$databaseTarget
  if ($target.Host -ne '127.0.0.1' -or $target.AbsolutePath -ne '/lyn_qa_retest') {
    throw 'Solo se permite ejecutar la suite completa contra 127.0.0.1/lyn_qa_retest.'
  }
  $env:DATABASE_URL = $databaseTarget
}
if ($SkipDatabaseIntegration) {
  Write-Warning 'Revisión parcial: no se ejecutarán las integraciones PostgreSQL de QA.'
  Remove-Item Env:QA_TEST_DATABASE_URL -ErrorAction SilentlyContinue
}

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

if (!$SkipDatabaseIntegration) { Invoke-ProjectCommand 'backend' @('npm', 'run', 'migrate') }
Invoke-ProjectCommand 'backend' @('npm', 'run', 'typecheck')
Invoke-ProjectCommand 'backend' @('npm', 'test')
Invoke-ProjectCommand 'frontend' @('npm', 'test')
Invoke-ProjectCommand 'frontend' @('npm', 'run', 'build')

Invoke-ProjectCommand 'extension' @('npm', 'test')
Invoke-ProjectCommand 'extension' @('npm', 'run', 'check')
Invoke-ProjectCommand '.' @('node', '--test', 'scripts/tests/release-safety.test.mjs')
Invoke-ProjectCommand 'evolution-api' @('node', 'scripts/patch-minio.cjs')
$env:DATABASE_PROVIDER = 'postgresql'
Invoke-ProjectCommand 'evolution-api' @('node', 'node_modules/prisma/build/index.js', 'generate', '--schema', 'prisma/postgresql-schema.prisma')
Invoke-ProjectCommand 'evolution-api' @('npm', 'run', 'build')
Invoke-ProjectCommand '.' @('node', '--test', 'scripts/tests/dependency-compatibility.test.mjs')
Invoke-ProjectCommand '.' @('node', '--test', 'scripts/tests/webhook-batches.test.mjs')
Invoke-ProjectCommand '.' @('node', 'scripts/check-dashboard.cjs')
foreach ($project in @('backend', 'frontend', 'evolution-api')) {
  Invoke-ProjectCommand $project @('npm', 'audit', '--omit=dev')
}

Write-Host 'Validación completa finalizada correctamente.' -ForegroundColor Green
