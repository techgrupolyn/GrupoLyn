$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EvolutionDir = Join-Path $RootDir "evolution-api"

Write-Host "==> Superagente WhatsApp — Setup local (sin Docker)"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 20+ es requerido"
}

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
  throw "PostgreSQL (psql) es requerido en PATH"
}

if (-not (Test-Path $EvolutionDir)) {
  Write-Host "==> Clonando Evolution API..."
  git clone https://github.com/EvolutionAPI/evolution-api.git $EvolutionDir
} else {
  Write-Host "==> Evolution API ya existe en $EvolutionDir"
}

Write-Host "==> Generando .env de Evolution API..."
@'
SERVER_NAME=evolution
SERVER_TYPE=http
SERVER_PORT=8080
SERVER_URL=http://localhost:8080

DATABASE_PROVIDER=postgresql
DATABASE_CONNECTION_URI='postgresql://postgres:postgres@localhost:5432/evolution_db?schema=evolution_api'
DATABASE_CONNECTION_CLIENT_NAME=superagente_local

DATABASE_SAVE_DATA_INSTANCE=true
DATABASE_SAVE_DATA_NEW_MESSAGE=true
DATABASE_SAVE_MESSAGE_UPDATE=true
DATABASE_SAVE_DATA_CONTACTS=true
DATABASE_SAVE_DATA_CHATS=true

CACHE_REDIS_ENABLED=false
CACHE_LOCAL_ENABLED=true
CACHE_REDIS_PREFIX_KEY=evolution

AUTHENTICATION_API_KEY=429683C4C977415CAAFCCE10F7D57E11
AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=true

CORS_ORIGIN=*
LOG_LEVEL=ERROR,WARN,INFO,WEBHOOKS
LOG_BAILEYS=error
DEL_INSTANCE=false
QRCODE_LIMIT=30
LANGUAGE=es
'@ | Set-Content -Path (Join-Path $EvolutionDir ".env") -Encoding UTF8

Write-Host "==> Creando bases de datos PostgreSQL..."
$dbExists = psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'evolution_db'"
if (-not $dbExists) { psql -U postgres -c "CREATE DATABASE evolution_db;" }
$dbExists = psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'superagente'"
if (-not $dbExists) { psql -U postgres -c "CREATE DATABASE superagente;" }

Write-Host "==> Aplicando schema del orquestador..."
psql -U postgres -d superagente -f (Join-Path $RootDir "schema.sql")

Write-Host "==> Instalando dependencias..."
Push-Location $EvolutionDir; npm install; Pop-Location
Push-Location (Join-Path $RootDir "backend"); npm install; Pop-Location
Push-Location (Join-Path $RootDir "frontend"); npm install; Pop-Location

$envExample = Join-Path $RootDir "backend\.env.example"
$envFile = Join-Path $RootDir "backend\.env"
if (-not (Test-Path $envFile)) { Copy-Item $envExample $envFile }

Write-Host @"

============================================================
  SETUP COMPLETADO — Comandos para levantar el entorno
============================================================

Terminal 1 — Evolution API (puerto 8080):
  cd evolution-api
  npm run start:prod

Terminal 2 — Backend Orquestador (puerto 3000):
  cd backend
  npm run dev

Terminal 3 — Dashboard React (puerto 5173):
  cd frontend
  npm run dev

Verificaciones:
  - Evolution API:  http://localhost:8080
  - Backend health: http://localhost:3003/health
  - Dashboard:      http://localhost:5173

============================================================
"@
