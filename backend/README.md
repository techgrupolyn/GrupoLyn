
## Modelo multi-cuenta centralizado

La plataforma usa una sola base de datos PostgreSQL. Cada cuenta de WhatsApp se registra en `whatsapp_accounts` con una instancia Evolution distinta. Los chats, mensajes, resúmenes, respuestas y activaciones de extensión llevan `account_id`; los identificadores internos se separan por cuenta para evitar colisiones aunque dos números pertenezcan al mismo grupo.

1. En el Dashboard CEO crea la cuenta con un identificador estable y el nombre de instancia Evolution.
2. Genera un código de extensión asociado a esa cuenta.
3. El empleado canjea el código una vez y escanea el QR de su propia instancia.
4. La extensión solo ve, sincroniza, resume y responde la información de su cuenta. El Dashboard CEO mantiene visibilidad global.

### Reinicio limpio de datos

> Esta operación elimina **todos** los datos de la base configurada en `DATABASE_URL`.

PowerShell:

```powershell
cd backend
$env:CONFIRM_CLEAN_RESET = 'YES'
npm run reset:clean
```

Después inicia el backend. Este crea el usuario CEO inicial desde `CEO_INITIAL_PASSWORD` y actualiza la cuenta `default` con `INSTANCE_NAME`.
