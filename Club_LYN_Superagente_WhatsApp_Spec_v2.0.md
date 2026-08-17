# Club LYN · Superagente de WhatsApp
## Documento base de especificación — v2.0

**Fecha:** 31 de julio de 2026
**Sustituye a:** v1.0 (julio 2026) — *Documento de alcance para PM · MVP · Fase 2 · Fase 3*
**Base vigente:** v1.0 sigue siendo la referencia para Fase 2 y Fase 3. Este documento redefine únicamente el MVP (Fase 1).
**Ámbito:** estructura operativa de España.

---

## Control del documento y gobierno

Este documento es la **única fuente de verdad** del MVP. Cualquier decisión de alcance que no esté aquí no está aprobada.

| Ámbito | Responsable | Qué decide |
|---|---|---|
| **Qué y por qué del negocio** | Jean Parra (PM Innovación IA) | Alcance, reglas de negocio, criterios de aceptación, prioridad. Valida que se cumpla la expectativa de negocio y lleva el seguimiento de los acuerdos de tiempo |
| **Cómo técnico** | Juan David Vizcaya (Tech Lead) | Arquitectura, modelo de datos, conector, stack, despliegue. **Toda decisión de arquitectura se aprueba en sesión conjunta Alejandro Yepez + Juan David** antes de implementarse |
| **Validación de negocio** | Alejandro Lorente (CEO) | Confirma que el resultado resuelve el dolor operativo |
| **Construcción** | Alejandro Yepez | Implementación y demostración de avance |

**Regla de proceso:** este documento describe el *qué* y el *por qué*. No prescribe implementación. Donde una sección toca arquitectura, se marca explícitamente como **[Definición técnica: sesión Alejandro + Juan David]**.

---

## 0. Qué cambia en v2.0 y por qué

La v1.0 se escribió antes de tener producto. Tras la demostración del 30/07 y las sesiones de definición posteriores, el negocio precisó cinco cosas que la v1.0 dejaba abiertas o resolvía de otra forma. Este bloque es el resumen de lo **nuevo**; el resto del documento es la especificación completa e integrada.

| # | Decisión v2.0 | Por qué | Estado en v1.0 |
|---|---|---|---|
| **N1** | **La pantalla de inicio es el producto.** Un botón resume todo lo no leído del rol y dice qué hay que contestar. El objetivo es que la interiorista no abra ningún chat | Es el ahorro de tiempo real. Todo lo demás es soporte de esto | Existía como "pantalla única" (§5), sin implementarse |
| **N2** | **El alcance del análisis es el estado de lectura, no una ventana de días.** Tras resumir, lo incluido queda marcado como leído **solo en el sistema** | Evita releer y evita reprocesar lo mismo. Marcar en WhatsApp mostraría doble check azul al cliente y generaría expectativa falsa | Nuevo |
| **N3** | **Solo interacciones con clientes.** El tráfico interno entre miembros del equipo se descarta y no genera issues | Reduce ruido, coste y riesgo de falsos positivos. El valor está en no dejar a un cliente sin respuesta | Nuevo |
| **N4** | **Visibilidad por relación real:** se registra qué usuarios de LYN recibieron cada mensaje; el rol del usuario determina la intervención sugerida | Resuelve *"si una persona no tiene relación con el asunto, no aparece ni en su resumen"* de forma determinista, sin depender del criterio del modelo | Regla existía (§4), sin mecanismo |
| **N5** | **Bandeja de respuesta en lote.** Varios asuntos en una pantalla, cada uno con su borrador editable, envío conjunto con intervalo entre mensajes | Pasa el tiempo de respuesta de "abrir 10 chats" a "revisar y aprobar una lista" | Nuevo |

**Aclaraciones de la v1.0 que se mantienen sin cambio:** revisión humana en el 100 % de los envíos, una única respuesta final por asunto, los números pertenecen a puestos, arquitectura reutilizable en fases 2 y 3.

---

## 1. Objetivo

Convertir los WhatsApp corporativos en **información filtrada por puesto y respuestas preparadas**, sin obligar a nadie a revisar conversaciones que no le corresponden.

La medida de éxito del MVP no es *"¿contesta solo?"*. Es: **¿cada puesto ve únicamente lo que debe saber y responder, con borradores útiles, sin abrir conversaciones?**

---

## 2. Alcance del MVP

### 2.1 Incluido

1. Conexión de las cuentas de WhatsApp corporativas de los miembros del equipo.
2. Detección de chats de cliente y descarte del tráfico interno.
3. Deduplicación del mismo chat de cliente visible desde varias cuentas del equipo.
4. Registro de qué usuarios de LYN recibieron cada mensaje.
5. Análisis de texto **y transcripción de audios**.
6. Clasificación por asunto, prioridad (urgente / pendiente / informativo) y roles relevantes.
7. Detección de asunto **pendiente de respuesta** vs. **ya respondido**.
8. Resumen filtrado por rol, separando *Información* de *Necesita respuesta*.
9. Pantalla de inicio con resumen de lo no leído y marcado en sistema.
10. Generación de respuesta con rol principal y rol de apoyo, cambiables por el usuario.
11. Bandeja de respuesta en lote con envío diferido.
12. Vista de Dirección y consulta en lenguaje natural sobre el contexto.
13. Importación de historiales exportados de chats de cliente, con multimedia.
14. Registro y auditoría de propuesta, edición, usuario y envío.
15. Despliegue accesible para toda la estructura.

### 2.2 Fuera del MVP

| Elemento | Destino |
|---|---|
| Redacción de **fragmento** para acceso cross-departamento y flujo *"Este asunto debe revisarlo oficina"* | Fase 2 |
| Expansión automática del historial hacia atrás ante referencias tipo *"como acordamos"* | Fase 2 |
| Notificaciones push / Firebase | Fase 2 |
| Conversaciones internas entre empleados como fuente de issues | Fase 2 |
| Transferencia interna automática entre números o departamentos | Fase 2 |
| Integración con Club LYN / ClickUp y creación de tareas | Fase 2 |
| Análisis de PDF, imágenes y documentos adjuntos | Fase 2 |
| Paridad visual completa con WhatsApp Web | Diferido — se revisa con feedback tras el despliegue |
| Segmentación por franquicia / multi-empresa | Fase 3 |
| Respuestas autónomas sin revisión humana | Fase 3 |

---

## 3. Roles y modelo de identidad

### 3.1 Roles de negocio

Un usuario tiene un rol asignado. El rol determina qué ve y qué intervención se le sugiere.

| Rol | Alcance de visibilidad |
|---|---|
| **Dirección (CEO / COO)** | Acceso total al contexto de todos los chats de cliente |
| **Interiorista** | Solo los chats de cliente en los que participa |
| **Planimetrista** | Solo los chats de cliente en los que participa |
| **Administración / Contabilidad** | Solo los chats de cliente en los que participa |
| **Comercial** | Solo los chats de cliente en los que participa |
| **Superadmin** | Rol de administración técnica del sistema. **No es un rol de negocio** y no participa en el flujo operativo |

Hay **varios usuarios por rol** (varios interioristas, varios planimetristas, varios directores). El sistema opera sobre usuarios, no sobre roles genéricos.

### 3.2 Rol de usuario vs. rol de respuesta

Son dos conceptos distintos que comparten una misma tabla configurable de roles:

- **Rol de usuario:** el puesto de la persona. Determina visibilidad y a quién se le sugiere intervenir.
- **Rol de respuesta (especialista):** el enfoque con el que se redacta el borrador. Puede coincidir con el rol del usuario o no.

Cada rol lleva asociado el **contexto del tipo de intervención que requiere**, que es lo que permite generar el borrador con el enfoque correcto.

> **Por qué importa:** permite que un asunto de obra se conteste con enfoque legal prudente sin necesidad de que exista un usuario "Legal". Es el caso que protege a la empresa cuando un cliente discute responsabilidad.

```gherkin
Dado un asunto que requiere un enfoque distinto al rol del usuario
Cuando el usuario cambia el rol de respuesta o añade un rol de apoyo
Entonces el borrador se regenera con el contexto de intervención de esos roles
Y el resultado sigue siendo una única respuesta final
```

---

## 4. Reglas de negocio

### 4.1 Detección de chats de cliente

**Por qué:** el sistema debe distinguir una conversación con cliente de una coordinación interna. Un mensaje interno tratado como issue de cliente genera falsos pendientes y ruido en todos los resúmenes.

**Regla MVP:** los chats de cliente se identifican por la nomenclatura **`Proyecto ` + nombre del proyecto**, que es la convención que el equipo ya aplica hoy. El sistema solo procesa esos chats.

**Regla de respaldo para chats individuales:** en conversaciones uno a uno, el nombre depende de cómo cada persona tenga guardado el contacto, por lo que la nomenclatura no es fiable de forma homogénea. Se complementa con el registro de empleados: **un número presente en la conversación y ausente del registro de empleados es un cliente**.

```gherkin
Dado un chat cuyo nombre comienza por "Proyecto "
Cuando el sistema procesa sus mensajes
Entonces el chat se marca como chat de cliente y entra en el análisis

Dado un chat que no sigue la nomenclatura "Proyecto "
Cuando el sistema lo evalúa
Entonces queda fuera del análisis del MVP y no genera issues

Dado un mensaje dentro de un chat de cliente emitido por un número registrado como empleado
Cuando el sistema lo clasifica
Entonces se registra como intervención interna y no genera un issue pendiente de respuesta
```

> **Ventaja de usar la convención existente:** el filtro no depende de que el equipo adopte un hábito nuevo, por lo que no hay riesgo de adopción asociado.
>
> ⚠️ **Verificación previa a cerrar la regla:** hay que confirmar la cobertura real de la nomenclatura. Cualquier chat de cliente que no la siga quedará fuera del análisis **de forma silenciosa** — es un falso negativo que no genera alerta. Acción de Producto antes del arranque.

### 4.2 Relación mensaje–usuario y visibilidad

**Por qué:** la v1.0 exigía que *"si una persona no tiene relación con el asunto, no aparezca ni en su resumen"*, pero no definía cómo se determina esa relación. Dejarlo al criterio del modelo es caro y poco fiable. Se resuelve con un dato, no con inferencia.

**Regla:** por cada mensaje se registra **qué usuarios de LYN tuvieron visibilidad de él** (es decir, qué miembros del equipo estaban en ese chat). Como cada usuario tiene un rol, el sistema deriva automáticamente qué roles tienen relación con cada interacción y a quién sugerir la intervención.

**[Definición técnica: sesión Alejandro + Juan David]** — La forma sugerida por Producto es una tabla de relación `mensaje_usuario {mensaje_id, user_id}`. La estructura final la aprueba Tech Lead.

```gherkin
Dado un mensaje en un chat de cliente
Cuando el sistema lo ingesta
Entonces registra la relación con cada usuario de LYN que tuvo visibilidad de ese mensaje

Dado un usuario que no tuvo visibilidad de un mensaje
Cuando accede a su resumen o a su bandeja
Entonces ese mensaje no aparece bajo ninguna vista suya

Dado un usuario con rol de Dirección
Cuando consulta el sistema
Entonces accede al contexto de todos los chats de cliente con independencia de su participación
```

### 4.3 Estado de lectura

**Por qué:** el usuario necesita que el resumen cubra lo que aún no ha visto, y que lo ya resumido no se vuelva a resumir. Marcarlo en WhatsApp haría que el cliente viese el doble check azul y asumiera que alguien leyó su mensaje, generando una expectativa que el equipo no ha asumido todavía.

**Regla:** el estado leído / no leído se gestiona **en el sistema, por usuario**, y es independiente del estado de lectura de la cuenta de WhatsApp. El sistema **no marca mensajes como leídos en WhatsApp**.

```gherkin
Dado un usuario que genera su resumen de la pantalla de inicio
Cuando el resumen se produce correctamente
Entonces los mensajes incluidos quedan marcados como leídos en el sistema para ese usuario
Y no vuelven a incluirse en resúmenes posteriores de ese usuario
Y su estado de lectura en WhatsApp permanece sin alterar

Dado un mismo chat de cliente con dos usuarios de LYN
Cuando el usuario A genera su resumen
Entonces el estado de no leído del usuario B permanece intacto
```

### 4.4 Estado del asunto: pendiente vs. ya respondido

**Por qué:** un mensaje sin leer no equivale a un cliente sin respuesta. Si un compañero ya contestó, mostrar ese asunto como pendiente hace perder tiempo y contradice el objetivo del producto.

**Regla MVP:** un asunto se considera **respondido** cuando cualquier usuario de LYN ha escrito en el chat después del último mensaje del cliente, **o** cuando un usuario lo marca explícitamente como respondido.

**En el flujo de respuesta en lote:** cada asunto lleva un check *"queda respondido con esta respuesta"* **premarcado en `true`**, visible y editable por el usuario antes de enviar.

> **Por qué premarcado:** el caso normal es que la respuesta cierre el asunto, y exigir un clic extra por asunto anularía la ventaja del lote. El riesgo de un falso "respondido" es bajo y se autocorrige: si el cliente vuelve a escribir, el asunto se reabre automáticamente como no leído. La auditoría registra si el estado se fijó de forma automática o manual.

**No entra en el MVP:** validación por IA de si la respuesta aborda realmente la pregunta. Se evalúa como mejora medida, porque un falso negativo dejaría a un cliente sin respuesta.

```gherkin
Dado un mensaje de cliente pendiente
Cuando cualquier usuario de LYN escribe en ese chat después del mensaje del cliente
Entonces el asunto pasa a estado respondido y deja de aparecer como pendiente para todos los roles

Dado un asunto en la bandeja de respuesta en lote
Cuando el usuario revisa el borrador
Entonces el check "queda respondido" aparece premarcado y puede desmarcarlo antes de enviar

Dado un asunto marcado como respondido
Cuando el cliente envía un mensaje nuevo en ese chat
Entonces el asunto se reabre como pendiente y no leído
```

### 4.5 Clasificación y prioridad

Cada asunto se etiqueta con: **tema**, **prioridad**, **roles relevantes** y **necesidad de respuesta**.

Prioridad con tres niveles: **urgente · pendiente · informativo**. Los tres alimentan los contadores de la pantalla de inicio, por lo que una detección binaria de urgencia no es suficiente.

La distinción **Información** vs. **Necesita respuesta** es el criterio central del producto: es lo que permite a alguien dejar de leer conversaciones.

---

## 5. Superficies de la aplicación

El MVP tiene **tres vistas**. La pantalla de inicio es la principal.

### 5.1 Pantalla de inicio — resumen (vista principal)

**Por qué:** es donde se materializa el objetivo. El usuario entra, pulsa un botón y sabe qué pasó y qué debe contestar, sin abrir ninguna conversación.

**Elementos:**

- Cabecera: rol activo, última actualización, botón de actualización.
- Botón **"Resumir mis WhatsApps"**.
- Contadores: **necesitan respuesta · urgentes · información relevante**.
- **Lista principal:** solo asuntos que esa persona debe contestar.
- **Lista secundaria:** información útil para su puesto, sin ruido.
- Acceso directo a la bandeja de respuesta en lote.

```gherkin
Dado un usuario con mensajes no leídos en chats de cliente de su relación
Cuando pulsa "Resumir mis WhatsApps"
Entonces recibe un resumen consolidado que cubre exclusivamente sus mensajes no leídos
Y el resumen separa "Necesita respuesta" de "Información"
Y los asuntos ya respondidos por otro usuario no aparecen como pendientes

Dado un usuario que ha estado varios días sin acceder
Cuando genera su resumen
Entonces el resumen cubre todo el periodo no leído, sin límite de ventana fija
```

### 5.2 Bandeja de conversaciones (modo WhatsApp)

Vista de trabajo sobre chats de cliente, para cuando el usuario necesita el detalle: contexto de la conversación, transcripción de audio, borrador, cambio de rol de respuesta y envío.

Acciones: copiar · editar · cambiar rol de respuesta · añadir rol de apoyo · regenerar · marcar contestado · **no me corresponde**.

### 5.3 Vista de Dirección y consulta en lenguaje natural

**Regla de acceso:** Dirección tiene **acceso total al contexto** en la consulta. La **interfaz muestra por defecto únicamente lo que requiere su atención**: decisiones, riesgos, cobros bloqueados, reclamaciones, retrasos, contradicciones y escalados.

**Por qué:** el CEO no necesita el ruido diario, pero sí necesita poder preguntar cualquier cosa. Y como el MVP no incluye notificaciones, **el tablero es el mecanismo por el que Dirección se entera al iniciar sesión**.

```gherkin
Dado un usuario con rol de Dirección
Cuando inicia sesión
Entonces el tablero muestra únicamente los asuntos que requieren su atención

Dado un usuario con rol de Dirección
Cuando formula una consulta en lenguaje natural
Entonces la consulta se resuelve sobre el contexto completo de todos los chats de cliente
```

---

## 6. Historial e importación

- **Carga inicial:** el sistema procesa el historial disponible de cada chat de cliente al conectarse la cuenta.
- **Modo incremental:** después solo procesa mensajes nuevos y conserva resumen, asuntos abiertos y última respuesta.
- **Importador de historiales:** función para incorporar conversaciones de chats de cliente a partir de la exportación nativa de WhatsApp, **con contenido multimedia incluido y sin cifrar**.

**Por qué el importador:** al conectar una cuenta no se recupera el histórico profundo, y buena parte del contexto de obra vive en conversaciones anteriores. Sin él, la IA arranca sin memoria de lo acordado.

**Fuera del MVP:** expansión automática hacia atrás ante referencias a acuerdos previos (Fase 2).

---

## 7. Respuesta y envío

### 7.1 Respuesta individual

Detecta → comprende → filtra → propone → **la persona revisa o edita** → aprueba y envía → se envía desde la misma cuenta corporativa que recibió el mensaje → se guarda la respuesta final.

### 7.2 Respuesta en lote

Varios asuntos en una pantalla, cada uno con su borrador editable manualmente o mediante instrucción a la IA, y envío conjunto.

**Regla de envío:** los mensajes se encolan y se envían con **intervalo entre envíos**. El envío inmediato y simultáneo de un lote completo no está permitido.

**Por qué:** un patrón de envío masivo instantáneo puede activar bloqueos de la plataforma sobre el número corporativo. El intervalo es requisito funcional, no una optimización.

**Revisión humana:** se mantiene al 100 %. Cambia de ser por caso a ser por lote — el usuario revisa los N borradores antes de aprobar el envío.

**[Definición técnica: sesión Alejandro + Juan David]** — Intervalo mínimo y máximo, tope de mensajes por lote, tope diario por cuenta y política de reintentos.

```gherkin
Dado un lote de respuestas revisadas y aprobadas
Cuando el usuario pulsa "Enviar todo"
Entonces cada mensaje se encola y se envía con un intervalo entre envíos
Y cada mensaje sale desde la cuenta corporativa que recibió el mensaje original
Y el usuario ve el estado individual de cada envío

Dado un envío fallido dentro de un lote
Cuando el sistema detecta el fallo
Entonces no bloquea el resto de la cola
Y el asunto permanece marcado como pendiente de respuesta
```

---

## 8. Auditoría

Toda respuesta generada, editada o enviada queda registrada con: propuesta original, roles aplicados, cambios del usuario, usuario que aprobó, resultado del envío y si el estado *"respondido"* se fijó de forma automática o manual.

**Por qué:** el sistema envía mensajes en nombre de Grupo LYN a clientes. Sin traza no hay forma de reconstruir qué se dijo, quién lo aprobó ni sobre qué base. Es requisito de cumplimiento, no una funcionalidad.

---

## 9. Despliegue

El Superagente es un **producto para toda la estructura de la empresa**, no un piloto local. Al cierre del desarrollo debe desplegarse en un entorno accesible por todo el equipo, con acceso autenticado por usuario.

**Por qué se explicita:** la visibilidad por rol solo tiene sentido si existe identidad de usuario en la aplicación. El acceso a WhatsApp no identifica al usuario del sistema.

**[Definición técnica: sesión Alejandro + Juan David]** — Entorno, autenticación, gestión de sesiones de WhatsApp por usuario y operativa de reconexión.

---

## 10. Criterios de aceptación del MVP

```gherkin
Dado el sistema en operación
Entonces cada usuario ve únicamente los chats de cliente con los que tiene relación
Y Dirección accede al contexto completo pero su tablero muestra solo lo que requiere su atención
Y los chats no aparecen duplicados aunque participen varias cuentas del equipo
Y el tráfico interno entre empleados no genera asuntos pendientes de cliente
Y el sistema distingue "Información" de "Necesita respuesta"
Y los asuntos ya respondidos por un compañero no aparecen como pendientes
Y el usuario puede cambiar el rol de respuesta y regenerar el borrador
Y el usuario puede responder varios asuntos desde una sola pantalla
Y toda respuesta exige revisión humana y queda registrada
Y la mayoría de los casos habituales se resuelve sin abrir la conversación completa
```

---

## 11. Fase 2 y Fase 3

Sin cambios respecto a v1.0, más lo desplazado desde el MVP (§2.2).

**Fase 2 — Coordinación operativa:** derivación interna entre departamentos, responsable y estado del caso, integración mínima con Club LYN / ClickUp, extracción de tareas y compromisos, análisis de PDF e imágenes, memoria por caso y por obra, resúmenes programados y alertas, redacción de fragmento y aprobación cross-departamento, expansión automática de historial, notificaciones push.

**Fase 3 — Autonomía controlada:** respuestas automáticas solo para casos verdes, consulta de planificación y contratos antes de afirmar datos, creación y seguimiento automático de tareas, persecución de pendientes, panel ejecutivo global, auditoría completa, reglas de riesgo con aprobación obligatoria.

---

## 12. Decisiones pendientes

| # | Decisión | Responsable | Estado |
|---|---|---|---|
| P1 | Tratamiento de datos personales en el envío de conversaciones de cliente a servicios de IA externos. Se propone incorporarlo a la consulta legal ya prevista para grabación de llamadas | Alejandro Lorente + asesoría legal | Abierta |
| P2 | Modelo de datos: relación mensaje�–usuario, estado de lectura por usuario, estado del asunto, auditoría | Sesión Alejandro Yepez + Juan David | Abierta |
| P3 | Conector y gestión de sesiones de WhatsApp por miembro del equipo | Sesión Alejandro Yepez + Juan David | Abierta |
| P4 | Parámetros de envío en lote: intervalo, tope por lote, tope diario, reintentos | Sesión Alejandro Yepez + Juan David | Abierta |
| P5 | Entorno de despliegue y autenticación de usuarios | Sesión Alejandro Yepez + Juan David | Abierta |
| P6 | Optimización de consumo de tokens: enrutado de modelos y reutilización de análisis por chat | Sesión Alejandro Yepez + Juan David | Abierta |
| P7 | Calendario de entrega del MVP sobre el alcance de este documento | Jean Parra con el equipo | Abierta |

---

_Documento base v2.0. Consolida la v1.0 (julio 2026) con las decisiones de la Revisión de Sprint del 30/07/2026 y las sesiones de definición de producto del 31/07/2026._
