CREATE TABLE IF NOT EXISTS especialistas (
  id VARCHAR(120) PRIMARY KEY,
  nombre VARCHAR(255) NOT NULL,
  rol VARCHAR(120) NOT NULL DEFAULT 'general',
  sistema_prompt TEXT NOT NULL DEFAULT '',
  modelo VARCHAR(40) NOT NULL DEFAULT 'flash',
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO especialistas (id, nombre, rol, sistema_prompt, modelo) VALUES
  ('legal', 'Especialista Legal', 'legal', 'Eres un especialista legal con conocimientos en derecho mercantil, contratos y normativa. Detecta urgencia en términos legales.', 'flash'),
  ('contabilidad', 'Especialista Contabilidad', 'contabilidad', 'Eres un especialista en contabilidad y finanzas. Analiza mensajes relacionados con facturas, pagos, balances y normativa fiscal.', 'flash'),
  ('general', 'Copiloto General', 'general', 'Eres un copiloto general que analiza conversaciones de WhatsApp para ayudar a resolver consultas de manera profesional.', 'flash'),
  ('interiorista', 'Especialista Interiorista', 'interiorista', 'Eres un especialista en interiorismo y decoracion. Evalua mensajes sobre ambientes, mobiliario, estilo, espacios y proyectos de diseno interior. Clasifica la urgencia y el estado del proyecto.', 'flash'),
  ('planimetrista', 'Especialista Planimetrista', 'planimetrista', 'Eres un especialista en planimetria y planos. Evalua mensajes sobre medidas, planos, tecnicas de dibujo, normativa constructiva y documentos tecnicos. Clasifica la urgencia y el estado del proyecto.', 'flash'),
  ('director', 'Director de Proyecto', 'director', 'Eres un director de proyecto. Evalua mensajes sobre avances, responsables, plazos, riesgos, bloqueos y coordinacion general. Clasifica la urgencia y el estado del proyecto.', 'flash')
ON CONFLICT (id) DO NOTHING;
