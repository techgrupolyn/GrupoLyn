#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVOLUTION_DIR="${ROOT_DIR}/evolution-api"

echo "==> Superagente WhatsApp — Setup local (sin Docker)"

command -v node >/dev/null 2>&1 || { echo "Node.js 20+ es requerido"; exit 1; }
command -v psql >/dev/null 2>&1 || { echo "PostgreSQL (psql) es requerido en PATH"; exit 1; }

if [ ! -d "${EVOLUTION_DIR}" ]; then
  echo "==> Clonando Evolution API..."
  git clone https://github.com/EvolutionAPI/evolution-api.git "${EVOLUTION_DIR}"
else
  echo "==> Evolution API ya existe en ${EVOLUTION_DIR}"
fi

echo "==> Generando .env de Evolution API..."
cat > "${EVOLUTION_DIR}/.env" <<'EOF'
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
EOF

echo "==> Creando bases de datos PostgreSQL..."
psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname = 'evolution_db'" | grep -q 1 \
  || psql -U postgres -c "CREATE DATABASE evolution_db;"
psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname = 'superagente'" | grep -q 1 \
  || psql -U postgres -c "CREATE DATABASE superagente;"

echo "==> Aplicando schema del orquestador..."
psql -U postgres -d superagente -f "${ROOT_DIR}/schema.sql" 2>/dev/null || psql -U postgres -d superagente -f "${ROOT_DIR}/schema.sql"

echo "==> Instalando dependencias Evolution API..."
(cd "${EVOLUTION_DIR}" && npm install)

echo "==> Instalando dependencias Backend..."
(cd "${ROOT_DIR}/backend" && npm install)
cp -n "${ROOT_DIR}/backend/.env.example" "${ROOT_DIR}/backend/.env" 2>/dev/null || true

echo "==> Instalando dependencias Frontend..."
(cd "${ROOT_DIR}/frontend" && npm install)

echo "==> Instalando dependencias Dashboard CEO..."
(cd "${ROOT_DIR}/ceo-dashboard" && npm install)

cat <<'INSTRUCTIONS'

============================================================
  SETUP COMPLETADO — Comandos para levantar el entorno
============================================================

Terminal 1 — Evolution API (puerto 8080):
  cd evolution-api
  npm run start:prod
  # o: npm run dev:server

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

El backend auto-configura la instancia "lyn-local" y el webhook
http://localhost:3003/webhook/evolution al arrancar.

============================================================
INSTRUCTIONS
