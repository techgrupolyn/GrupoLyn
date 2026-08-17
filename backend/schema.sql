
-- Cuenta inicial. El backend sustituye evolution_instance_name por INSTANCE_NAME al iniciar.
INSERT INTO whatsapp_accounts (id, nombre, evolution_instance_name)
VALUES ('default', 'Cuenta principal', 'default')
ON CONFLICT (id) DO NOTHING;
