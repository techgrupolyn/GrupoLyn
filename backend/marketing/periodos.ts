// Ventanas del panel: los 6 últimos meses naturales completos y las 4 últimas semanas completas (lunes a
// domingo), siempre en hora de Madrid. Las fechas son días de calendario (YYYY-MM-DD), sin hora.
export const ZONA_HORARIA = 'Europe/Madrid';
const DIA_MS = 86_400_000;
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export type Periodo = {
  i: number;
  bloque: 0 | 1;          // 0 = meses, 1 = semanas
  etiqueta: string;       // «May», «5–11»
  sub: string;            // «», «oct», «oct–nov»
  largo: string;          // «mayo de 2026», «26 oct–1 nov 2026»
  desde: string;          // primer día incluido
  hasta: string;          // último día incluido
  dias: number;
  edadMedia: number;      // días entre el centro del periodo y el corte
  edadFin: number;        // días entre el último día y el corte
};

/** Día de calendario de Madrid para un instante. */
export function diaMadrid(instante: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instante);
}

const aUtc = (dia: string) => { const [y, m, d] = dia.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const aDia = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Corte = hoy en Madrid. Ningún periodo incluye la semana ni el mes en curso. */
export function calcularPeriodos(ahora: Date = new Date()): { corte: string; periodos: Periodo[] } {
  const corte = diaMadrid(ahora);
  const corteMs = aUtc(corte);
  const hoy = new Date(corteMs);
  const out: Periodo[] = [];
  const add = (bloque: 0 | 1, desdeMs: number, hastaMs: number, etiqueta: string, sub: string, largo: string) => {
    out.push({
      i: out.length, bloque, etiqueta, sub, largo, desde: aDia(desdeMs), hasta: aDia(hastaMs),
      dias: Math.round((hastaMs - desdeMs) / DIA_MS) + 1,
      edadMedia: (corteMs - (desdeMs + hastaMs) / 2) / DIA_MS,
      edadFin: (corteMs - hastaMs) / DIA_MS,
    });
  };
  for (let k = 6; k >= 1; k--) {
    const desde = Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - k, 1);
    const hasta = Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - k + 1, 0);
    const d = new Date(desde);
    const nombre = MESES[d.getUTCMonth()];
    add(0, desde, hasta, nombre[0].toUpperCase() + nombre.slice(1, 3), '', `${nombre} de ${d.getUTCFullYear()}`);
  }
  const lunesActual = corteMs - ((hoy.getUTCDay() + 6) % 7) * DIA_MS;
  for (let k = 4; k >= 1; k--) {
    const desde = lunesActual - 7 * k * DIA_MS;
    const hasta = desde + 6 * DIA_MS;
    const a = new Date(desde), b = new Date(hasta);
    const mismoMes = a.getUTCMonth() === b.getUTCMonth();
    const ma = MESES_CORTOS[a.getUTCMonth()], mb = MESES_CORTOS[b.getUTCMonth()];
    add(1, desde, hasta, `${a.getUTCDate()}–${b.getUTCDate()}`, mismoMes ? ma : `${ma}–${mb}`,
      mismoMes ? `${a.getUTCDate()}–${b.getUTCDate()} ${ma} ${b.getUTCFullYear()}` : `${a.getUTCDate()} ${ma}–${b.getUTCDate()} ${mb} ${b.getUTCFullYear()}`);
  }
  return { corte, periodos: out };
}

/** Índices de los periodos que contienen un día (puede estar en un mes y en una semana a la vez). */
export function periodosDelDia(dia: string, periodos: Periodo[]): number[] {
  return periodos.filter((p) => p.desde <= dia && dia <= p.hasta).map((p) => p.i);
}
