@echo off
setlocal

where psql >nul 2>nul
if %errorlevel% neq 0 (
  echo ERROR: No se encontro psql. Instala PostgreSQL y agregalo al PATH.
  pause
  exit /b 1
)

echo.
echo === PASO 1: Creando bases de datos si no existen ===
psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname = 'evolution_db';" | findstr 1 >nul
if %errorlevel% neq 0 (
  psql -U postgres -c "CREATE DATABASE evolution_db;"
) else (
  echo evolution_db ya existe.
)

psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname = 'superagente';" | findstr 1 >nul
if %errorlevel% neq 0 (
  psql -U postgres -c "CREATE DATABASE superagente;"
) else (
  echo superagente ya existe.
)

echo.
echo === PASO 2: Aplicando schema.sql ===
psql -U postgres -d superagente -f schema.sql
if %errorlevel% neq 0 (
  echo ERROR: Fallo al aplicar schema.sql
  pause
  exit /b 1
)

echo.
echo === PASO 3: Iniciando servicios ===
echo Recuerda abrir 3 terminales nuevas y ejecutar:
echo.
echo Terminal 1 - Evolution API:
echo   cd %~dp0evolution-api
echo   npm.cmd run dev:server
echo.
echo Terminal 2 - Backend:
echo   cd %~dp0backend
echo   npm.cmd run dev
echo.
echo Terminal 3 - Dashboard:
echo   cd %~dp0frontend
echo   npm.cmd run dev -- --host 127.0.0.1
echo.
echo Luego abre: http://127.0.0.1:5173
echo.
pause
