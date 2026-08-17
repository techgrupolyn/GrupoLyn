param(
  [string]$OutputPath = 'dist\lyn-superagente-extension.zip'
)

$extensionRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outputFile = if ([System.IO.Path]::IsPathRooted($OutputPath)) {
  [System.IO.Path]::GetFullPath($OutputPath)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $extensionRoot $OutputPath))
}
$outputDirectory = Split-Path -Parent $outputFile
$stage = Join-Path $outputDirectory 'package-stage'

New-Item -ItemType Directory -Force $outputDirectory | Out-Null
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
if (Test-Path -LiteralPath $outputFile) { Remove-Item -LiteralPath $outputFile -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
New-Item -ItemType Directory -Force (Join-Path $stage 'scripts') | Out-Null

Copy-Item -LiteralPath (Join-Path $extensionRoot 'manifest.json') -Destination $stage
Copy-Item -LiteralPath (Join-Path $extensionRoot 'src') -Destination $stage -Recurse
Copy-Item -LiteralPath (Join-Path $extensionRoot 'scripts\icons') -Destination (Join-Path $stage 'scripts') -Recurse
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $outputFile -Force
Remove-Item -LiteralPath $stage -Recurse -Force
Write-Output "Extensión empaquetada en: $outputFile"