// Invitados de cada reunión desde Google Calendar (869fppbcj, bloque B · lead).
//
// Cuando el Agente de Reuniones identifica al organizador con Calendar, guarda el evento en
// meeting_artifact_organizers.assigned_by = 'calendar:<id del evento>'. Aquí se pide ESE evento (solo lectura) y
// se guardan sus invitados en reunion.invitados. Así no se toca linkMeetingOrganizer ni se vuelve a buscar el evento.
// Cuando se localice el CRM, el lead se buscará por estos emails.
//
// Estados de la consulta (columnas de reunion):
//   invitados_en IS NULL                      pendiente de consultar
//   invitados_en + invitados_reintentar=FALSE  terminado (con invitados o con un motivo definitivo)
//   invitados_en + invitados_reintentar=TRUE   fallo temporal: se reintenta pasada REINTENTO_HORAS
import type { Pool } from 'pg';

type Consultable = Pick<Pool, 'query'>;

export const LOTE_INVITADOS = 20;
export const REINTENTO_HORAS = 1;

export type Invitado = { email: string; nombre: string | null; respuesta: string | null; organizador: boolean; interno: boolean };
type AsistenteCalendar = { email?: string; displayName?: string; responseStatus?: string; organizer?: boolean; resource?: boolean };
type MomentoCalendar = { dateTime?: string; date?: string };
export type EventoCalendar = { id?: string; status?: string; attendees?: AsistenteCalendar[]; start?: MomentoCalendar; end?: MomentoCalendar };
export type ObtenerToken = (connectionId: string) => Promise<string>;
export type PedirEvento = (token: string, eventId: string) => Promise<EventoCalendar>;

export class ErrorCalendar extends Error {
  constructor(message: string, readonly status: number | null) { super(message); }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Invitados limpios: sin salas ni recursos de Calendar, sin emails inválidos ni repetidos.
 * `interno` = es un empleado (por email); el lead se buscará solo entre los externos.
 */
export function invitadosDelEvento(evento: EventoCalendar, emailsEquipo: Set<string>): Invitado[] {
  const vistos = new Set<string>();
  const invitados: Invitado[] = [];
  for (const a of evento.attendees || []) {
    const email = String(a.email || '').trim().toLowerCase();
    if (a.resource || !EMAIL.test(email) || email.endsWith('resource.calendar.google.com') || vistos.has(email)) continue;
    vistos.add(email);
    invitados.push({
      email,
      nombre: a.displayName?.trim() || null,
      respuesta: a.responseStatus || null,
      organizador: a.organizer === true,
      interno: emailsEquipo.has(email),
    });
  }
  return invitados;
}

/**
 * Inicio y fin del evento (con hora). Un evento de día entero no tiene hora: no sirve para saber cuándo fue la reunión.
 * Duración: la del evento, si es coherente (entre 1 minuto y 8 horas).
 */
export function horarioDelEvento(evento: EventoCalendar): { inicio: string | null; fin: string | null; duracion_segundos: number | null } {
  const inicio = evento.start?.dateTime ? new Date(evento.start.dateTime) : null;
  const fin = evento.end?.dateTime ? new Date(evento.end.dateTime) : null;
  const valido = (d: Date | null) => (d && Number.isFinite(d.getTime()) ? d : null);
  const i = valido(inicio); const f = valido(fin);
  const segundos = i && f ? Math.round((f.getTime() - i.getTime()) / 1000) : null;
  return { inicio: i?.toISOString() ?? null, fin: f?.toISOString() ?? null, duracion_segundos: segundos && segundos >= 60 && segundos <= 8 * 3600 ? segundos : null };
}

/** Id del evento si el organizador lo vinculó Calendar (`calendar:<id>`); null si fue a mano. */
export function eventoDeAsignacion(assignedBy: string | null | undefined): string | null {
  const m = /^calendar:(.+)$/.exec(String(assignedBy || '').trim());
  return m ? m[1] : null;
}

/** Pide un evento concreto del calendario principal de la cuenta conectada. Solo lectura. */
export async function eventoCalendar(token: string, eventId: string): Promise<EventoCalendar> {
  const params = new URLSearchParams({ fields: 'id,status,start(dateTime,date),end(dateTime,date),attendees(email,displayName,responseStatus,organizer,resource)' });
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?${params}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new ErrorCalendar(`Calendar respondió ${response.status} al pedir el evento.`, response.status);
  return await response.json() as EventoCalendar;
}

type Candidata = { id: string; connection_id: string; scope: string | null; assigned_by: string | null };
type Horario = ReturnType<typeof horarioDelEvento>;
type Resultado = { invitados: Invitado[] | null; motivo: string | null; reintentar: boolean; horario?: Horario };

async function consultar(c: Candidata, equipo: Set<string>, obtenerToken: ObtenerToken, pedirEvento: PedirEvento): Promise<Resultado> {
  const eventId = eventoDeAsignacion(c.assigned_by);
  if (!c.assigned_by) return { invitados: null, motivo: 'Sin organizador todavía.', reintentar: true };
  if (!eventId) return { invitados: null, motivo: 'Organizador vinculado a mano: no hay evento de Calendar.', reintentar: false };
  // Reconectar la cuenta con permiso de Calendar lo arregla: se reintenta.
  if (!String(c.scope || '').includes('/auth/calendar')) return { invitados: null, motivo: 'La conexión no tiene permiso de lectura de Calendar.', reintentar: true };
  try {
    const evento = await pedirEvento(await obtenerToken(c.connection_id), eventId);
    if (evento.status === 'cancelled') return { invitados: null, motivo: 'El evento de Calendar está cancelado.', reintentar: false };
    return { invitados: invitadosDelEvento(evento, equipo), motivo: null, reintentar: false, horario: horarioDelEvento(evento) };
  } catch (error) {
    const status = error instanceof ErrorCalendar ? error.status : null;
    // 404/410: el evento ya no existe; no tiene sentido insistir. Lo demás (red, 5xx, token) es temporal.
    const definitivo = status === 404 || status === 410;
    return { invitados: null, motivo: (error as Error).message.slice(0, 300), reintentar: !definitivo };
  }
}

/**
 * Guarda los invitados de las reuniones aún sin consultar (y reintenta los fallos temporales cada hora).
 * Devuelve cuántas reuniones consultó. Nunca escribe en Calendar.
 */
export async function guardarInvitados(pool: Consultable, obtenerToken: ObtenerToken, pedirEvento: PedirEvento = eventoCalendar, lote = LOTE_INVITADOS): Promise<number> {
  const { rows } = await pool.query<Candidata>(
    `SELECT r.id, a.connection_id, c.scope, o.assigned_by
     FROM reunion r
     JOIN google_drive_artifacts a ON a.id = r.artifact_id
     JOIN google_drive_connections c ON c.id = a.connection_id AND c.revoked_at IS NULL
     LEFT JOIN meeting_artifact_organizers o ON o.artifact_id = r.artifact_id
     WHERE r.invitados_en IS NULL
        OR (r.invitados_reintentar AND r.invitados_en < NOW() - make_interval(hours => $2))
     ORDER BY r.invitados_en NULLS FIRST, r.id
     LIMIT $1`,
    [lote, REINTENTO_HORAS],
  );
  if (!rows.length) return 0;
  const equipo = new Set((await pool.query<{ email: string }>(
    `SELECT LOWER(TRIM(email)) AS email FROM empleados WHERE email IS NOT NULL AND TRIM(email) <> ''`,
  )).rows.map((r) => r.email));
  // Un token por conexión y vuelta, aunque haya varias reuniones de la misma cuenta.
  const tokens = new Map<string, Promise<string>>();
  const tokenCacheado: ObtenerToken = (id) => {
    if (!tokens.has(id)) tokens.set(id, obtenerToken(id));
    return tokens.get(id)!;
  };
  for (const c of rows) {
    const r = await consultar(c, equipo, tokenCacheado, pedirEvento);
    await pool.query(
      `UPDATE reunion SET invitados = COALESCE($2::jsonb, invitados), invitados_motivo = $3, invitados_reintentar = $4,
              invitados_en = NOW(), inicio = COALESCE($5::timestamptz, inicio), fin = COALESCE($6::timestamptz, fin),
              duracion_segundos = COALESCE(duracion_segundos, $7)
       WHERE id = $1`,
      // Sin tocar actualizado_en: vincularPendientes lo compara con assigned_at para saber si una sin_comercial
      // tiene un organizador nuevo, y moverlo aquí escondería esa asignación.
      [c.id, r.invitados ? JSON.stringify(r.invitados) : null, r.motivo, r.reintentar, r.horario?.inicio ?? null, r.horario?.fin ?? null, r.horario?.duracion_segundos ?? null],
    );
  }
  return rows.length;
}
