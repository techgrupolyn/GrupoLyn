# Superagente WhatsApp - Guía de Instalación Completa

## 📋 Resumen del Proyecto

Sistema de orquestación local para WhatsApp usando:
- **Evolution API** (Motor WhatsApp en puerto 8080)
- **PostgreSQL** (Base de datos en puerto 5432)
- **Node.js + Express** (Backend orquestador en puerto 3000)
- **React + Vite + Tailwind** (Dashboard en puerto 5173)

---

## 🔧 Requisitos Previos

### 1. Node.js 20+
```powershell
node --version
# Debe mostrar v20.x o superior
```

### 2. PostgreSQL 14+ (puerto 5432)
```powershell
# Verificar instalación
psql --version

# Ruta típica en Windows:
# C:\Program Files\PostgreSQL\16\bin\psql.exe
```

### 3. Git
```powershell
git --version
```

---

## 📁 Estructura del Proyecto

```
superagente-whatsapp/
├── evolution-api/          # Motor WhatsApp (clonado de GitHub)
├── backend/                # Backend orquestador
│   ├── server.js
│   ├── .env
│   └── package.json
├── frontend/               # Dashboard React
│   ├── src/
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   └── index.css
│   └── package.json
├── schema.sql              # Esquema de base de datos
├── start.bat              # Script de inicialización Windows
└── README.md              # Documentación básica
```

---

## 🚀 PASO 1: Configuración de Base de Datos PostgreSQL

### 1.1 Crear bases de datos necesarias

```powershell
# Abrir terminal y ejecutar:
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -c "CREATE DATABASE evolution_db;"
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -c "CREATE DATABASE superagente;"
```

### 1.2 Aplicar esquema SQL

```powershell
# Desde la raíz del proyecto:
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -d superagente -f schema.sql
```

**Verificación:**
```powershell
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -d superagente -c "\dt"
# Debe mostrar las tablas: chats y mensajes
```

---

## 🔌 PASO 2: Configuración de Evolution API

### 2.1 Verificar que Evolution API está clonado

```powershell
cd evolution-api
git status
```

Si no existe, clonarlo:
```powershell
cd ..
git clone https://github.com/EvolutionAPI/evolution-api.git evolution-api
```

### 2.2 Crear archivo .env de Evolution API

```powershell
cd evolution-api
```

Crear archivo `.env` con el siguiente contenido:

```env
SERVER_NAME=evolution
SERVER_TYPE=http
SERVER_PORT=8080
SERVER_URL=http://localhost:8080

DATABASE_PROVIDER=postgresql
DATABASE_CONNECTION_URI=postgresql://postgres:postgres@localhost:5432/evolution_db?schema=evolution_api
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
```

### 2.3 Resolver problema de paquetes Git en npm

```powershell
# Crear archivo .npmrc en evolution-api/
cd evolution-api
```

Crear archivo `.npmrc` con:
```
git=all
```

### 2.4 Instalar dependencias de Evolution API

```powershell
cd evolution-api

# Opción 1: Instalación estándar
npm install --legacy-peer-deps

# Opción 2: Si falla por paquetes git, instalar manualmente libsignal
git clone https://github.com/whiskeysockets/libsignal-node.git temp-libsignal
cd temp-libsignal
npm install
cd ..
npm install ./temp-libsignal --save
Remove-Item -Recurse -Force temp-libsignal
npm install --legacy-peer-deps
```

### 2.5 Generar y deployar base de datos de Evolution API

```powershell
cd evolution-api

# Generar cliente Prisma
npm run db:generate

# Deployar migraciones (Windows)
npm run db:deploy:win
```

---

## ⚙️ PASO 3: Configuración del Backend

### 3.1 Verificar archivo .env del backend

```powershell
cd backend
```

El archivo `.env` debe contener:

```env
PORT=3003
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/superagente

EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=429683C4C977415CAAFCCE10F7D57E11
INSTANCE_NAME=lyn-local
WEBHOOK_URL=http://localhost:3003/webhook/evolution
```

Si no existe, copiar desde `.env.example`:
```powershell
cd backend
Copy-Item .env.example .env
```

### 3.2 Instalar dependencias del backend

```powershell
cd backend
npm install
```

---

## 🎨 PASO 4: Configuración del Frontend

### 4.1 Instalar dependencias del frontend

```powershell
cd frontend
npm install
```

### 4.2 Verificar configuración de Tailwind

El archivo `tailwind.config.js` debe tener los colores personalizados:

```javascript
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        'main-bg': '#0D0D0D',
        'surface': '#141414',
        'border': '#2E2E2E',
        'primary-text': '#F2F2F2',
        'secondary-text': '#737373',
        'accent': '#BFBFBF',
      },
    },
  },
  plugins: [],
};
```

---

## 🚀 PASO 5: Iniciar el Sistema (3 Terminales)

### Terminal 1: Evolution API (Puerto 8080)

```powershell
cd C:\Users\albin\Projects\superagente-whatsapp\evolution-api

# Opción A: Modo desarrollo (recomendado para inicio)
npm run dev:server

# Opción B: Modo producción (requiere build previo)
npm run build
npm run start:prod
```

**Verificación:**
```powershell
# En otra terminal, verificar que está funcionando
curl http://localhost:8080/health
```

### Terminal 2: Backend Orquestador (Puerto 3000)

```powershell
cd C:\Users\albin\Projects\superagente-whatsapp\backend

# Iniciar en modo desarrollo con auto-reload
npm run dev
```

**Output esperado:**
```
[server] Backend escuchando en http://localhost:3003
[boot] Iniciando auto-configuración con Evolution API...
[boot] Evolution API disponible
[boot] Instancia "lyn-local" ya existe (o creándola)
[boot] Configurando webhook -> http://localhost:3003/webhook/evolution
[boot] Auto-configuración completada
```

**Verificación:**
```powershell
curl http://localhost:3003/health
```

### Terminal 3: Dashboard React (Puerto 5173)

```powershell
cd C:\Users\albin\Projects\superagente-whatsapp\frontend

# Iniciar servidor de desarrollo
npm run dev
```

**Output esperado:**
```
VITE v6.4.3  ready in 737 ms
➜  Local:   http://localhost:5173/
```

---

## 📱 PASO 6: Conectar WhatsApp

### 6.1 Abrir el Dashboard

Navegar a: `http://localhost:5173`

### 6.2 Escanear Código QR

1. Verás la pantalla de autenticación con el código QR
2. Abre WhatsApp en tu teléfono
3. Ve a Configuración → Dispositivos vinculados
4. Escanea el QR mostrado en el dashboard

### 6.3 Verificar conexión

Una vez escaneado, el dashboard cambiará automáticamente a la vista de chats.

---

## 🔍 Solución de Problemas

### Problema 1: npm install falla con EALLOWGIT

**Causa:** npm tiene deshabilitados los paquetes git por defecto.

**Solución:**
```powershell
# Crear .npmrc en evolution-api/
cd evolution-api
echo "git=all" > .npmrc

# O configurar globalmente
npm config set git all --global
```

### Problema 2: Evolution API no inicia

**Verificar:**
1. PostgreSQL está corriendo en puerto 5432
2. Las bases de datos evolution_db y superagente existen
3. El archivo .env de Evolution API está configurado correctamente

**Logs de Evolution API:**
```powershell
cd evolution-api
npm run dev:server
# Revisar logs en consola
```

### Problema 3: Backend no conecta con Evolution API

**Verificar:**
```powershell
# Test de conexión a Evolution API
curl http://localhost:8080/instance/fetchInstances -H "apikey: 429683C4C977415CAAFCCE10F7D57E11"
```

### Problema 4: Frontend no conecta con Backend

**Verificar:**
1. Backend está corriendo en puerto 3000
2. Vite proxy está configurado en `vite.config.js`:
```javascript
   server: {
     port: 5173,
     proxy: {
       '/api': 'http://localhost:3003',
       '/webhook': 'http://localhost:3003',
     },
   },
```

### Problema 5: PostgreSQL connection refused

**Solución:**
```powershell
# Verificar que PostgreSQL está corriendo
# En Windows: Services.msc → PostgreSQL 16

# O iniciar manualmente
& "C:\Program Files\PostgreSQL\16\bin\pg_ctl.exe" -D "C:\Program Files\PostgreSQL\16\data" start
```

---

## 📊 Flujo de Auto-configuración del Backend

Al iniciar el backend (`server.js`), se ejecuta automáticamente:

1. **Espera a Evolution API** (máximo 30 intentos, 2 segundos cada uno)
2. **Verifica instancia "lyn-local"** (`GET /instance/fetchInstances`)
3. **Crea instancia si no existe** (`POST /instance/create`)
4. **Configura webhook** (`POST /webhook/set/lyn-local`)
   - URL: `http://localhost:3003/webhook/evolution`
   - Eventos: `MESSAGES_UPSERT`, `CONNECTION_UPDATE`

---

## 🗄️ Estructura de Base de Datos

### Tabla `chats`
```sql
CREATE TABLE chats (
    id         VARCHAR(255) PRIMARY KEY,
    nombre     VARCHAR(255) NOT NULL DEFAULT 'Sin nombre',
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

### Tabla `mensajes`
```sql
CREATE TABLE mensajes (
    id         VARCHAR(255) PRIMARY KEY,
    chat_id    VARCHAR(255) NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    remitente  VARCHAR(255) NOT NULL,
    texto      TEXT         NOT NULL,
    timestamp  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

### Función de deduplicación
```sql
CREATE OR REPLACE FUNCTION insert_mensaje_idempotente(
    p_id        VARCHAR(255),
    p_chat_id   VARCHAR(255),
    p_remitente VARCHAR(255),
    p_texto     TEXT,
    p_timestamp TIMESTAMPTZ DEFAULT NOW()
) RETURNS VOID AS $$
BEGIN
    INSERT INTO chats (id, nombre, updated_at)
    VALUES (p_chat_id, p_remitente, p_timestamp)
    ON CONFLICT (id) DO UPDATE
        SET updated_at = EXCLUDED.updated_at,
            nombre     = CASE
                WHEN chats.nombre = 'Sin nombre' THEN EXCLUDED.nombre
                ELSE chats.nombre
            END;

    INSERT INTO mensajes (id, chat_id, remitente, texto, timestamp)
    VALUES (p_id, p_chat_id, p_remitente, p_texto, p_timestamp)
    ON CONFLICT (id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;
```

---

## 🌐 API REST del Backend

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/auth/status` | Estado de conexión WhatsApp |
| GET | `/api/auth/qr` | QR base64 si no está conectado |
| POST | `/webhook/evolution` | Receptor de eventos Evolution |
| GET | `/api/chats` | Lista de conversaciones |
| GET | `/api/chats/:id/mensajes` | Mensajes de un chat |
| POST | `/api/enviar` | Enviar texto vía Evolution |

---

## 🎨 Diseño del Frontend

### Paleta de Colores
- **Main Background:** `#0D0D0D` (Negro profundo)
- **Surface/Cards:** `#141414` (Gris oscuro)
- **Borders:** `#2E2E2E`
- **Primary Text:** `#F2F2F2`
- **Secondary Text:** `#737373`
- **Primary Accent & Buttons:** `#BFBFBF` (con texto negro)

### Vistas del Dashboard
1. **Vista de Autenticación:** Muestra QR para conectar WhatsApp
2. **Vista de Dashboard:** Panel izquierdo con lista de chats, panel derecho con mensajes y área de borrador

---

## 📝 Checklist Final de Instalación

- [ ] PostgreSQL instalado y corriendo (puerto 5432)
- [ ] Bases de datos `evolution_db` y `superagente` creadas
- [ ] Schema SQL aplicado a base de datos `superagente`
- [ ] Evolution API clonado y configurado
- [ ] Archivo `.env` de Evolution API creado
- [ ] Dependencias de Evolution API instaladas
- [ ] Migraciones de Evolution API deployadas
- [ ] Backend configurado con archivo `.env`
- [ ] Dependencias del backend instaladas
- [ ] Frontend configurado con Tailwind
- [ ] Dependencias del frontend instaladas
- [ ] Evolution API iniciado en puerto 8080
- [ ] Backend iniciado en puerto 3000
- [ ] Frontend iniciado en puerto 5173
- [ ] QR escaneado y WhatsApp conectado

---

## 🚀 Comandos Rápidos de Inicio

```powershell
# Terminal 1 - Evolution API
cd C:\Users\albin\Projects\superagente-whatsapp\evolution-api
npm run dev:server

# Terminal 2 - Backend
cd C:\Users\albin\Projects\superagente-whatsapp\backend
npm run dev

# Terminal 3 - Frontend
cd C:\Users\albin\Projects\superagente-whatsapp\frontend
npm run dev
```

Luego abrir: `http://localhost:5173`

---

## 📞 Soporte

Si encuentras problemas:
1. Revisa los logs de cada servicio en su terminal correspondiente
2. Verifica que todos los puertos estén disponibles (8080, 3000, 5173, 5432)
3. Confirma que PostgreSQL esté corriendo
4. Verifica los archivos `.env` en cada componente

---

**¡Sistema listo para usar! Una vez escaneado el QR, el dashboard mostrará tus conversaciones de WhatsApp.**
