[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$destination = Join-Path $root ".local-backups\pre-qa-$stamp"
$postgresBin = 'C:\Program Files\PostgreSQL\16\bin'
$databases = @('lyn_evolution_qa_live', 'lyn_qa_drive', 'lyn_qa_live', 'lyn_qa_restore_20260928', 'lyn_qa_retest', 'postgres')

function Invoke-Checked {
  param([string]$Program, [string[]]$Arguments)
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Falló el respaldo: $Program (código $LASTEXITCODE)" }
}

New-Item -ItemType Directory -Path $destination | Out-Null
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $destination
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($identity, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $destination -AclObject $acl

Push-Location $root
try {
  $head = (& git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo leer HEAD' }
  $remote = (& git rev-parse origin/main).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo leer origin/main' }
  Invoke-Checked git @('bundle', 'create', (Join-Path $destination 'repository.bundle'), '--all')
  Invoke-Checked git @('bundle', 'verify', (Join-Path $destination 'repository.bundle'))
  Invoke-Checked git @('diff', '--binary', "--output=$(Join-Path $destination 'working-tree.patch')", 'HEAD')
  Invoke-Checked tar @('-czf', (Join-Path $destination 'workspace-private.tar.gz'), '--exclude=.git', '--exclude=node_modules', '--exclude=.local-backups', '.')
  Invoke-Checked tar @('-tf', (Join-Path $destination 'workspace-private.tar.gz')) | Out-Null
  Invoke-Checked (Join-Path $postgresBin 'pg_dumpall.exe') @('-h', '127.0.0.1', '-p', '55439', '-U', 'postgres', '--globals-only', '--file', (Join-Path $destination 'postgres-globals-private.sql'))
  foreach ($database in $databases) {
    $dump = Join-Path $destination "$database.dump"
    Invoke-Checked (Join-Path $postgresBin 'pg_dump.exe') @('-h', '127.0.0.1', '-p', '55439', '-U', 'postgres', '-d', $database, '-Fc', '-f', $dump)
    Invoke-Checked (Join-Path $postgresBin 'pg_restore.exe') @('--list', $dump) | Out-Null
    Write-Host "Base local respaldada: $database"
  }
  $files = @(Get-ChildItem -LiteralPath $destination -File | ForEach-Object {
    [ordered]@{ name = $_.Name; bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
  })
  [ordered]@{
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    source = $root
    localHead = $head
    originMain = $remote
    databases = $databases
    scope = 'Local only. No production or Supabase backup. Source, uncommitted files, private configuration and build artifacts included. Reinstallable node_modules excluded. Git history stored separately in bundle. Independent PostgreSQL snapshots, not a cross-database atomic snapshot.'
    protection = 'NTFS access restricted to current user and SYSTEM. Archive not encrypted. Never upload these files to GitHub.'
    validation = 'Git bundle verified; archive readable; pg_restore list readable for each dump. Full restore not performed in this backup operation.'
    files = $files
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $destination 'manifest.json') -Encoding utf8
  Write-Host "BACKUP_DIRECTORY=$destination"
} finally {
  Pop-Location
}
