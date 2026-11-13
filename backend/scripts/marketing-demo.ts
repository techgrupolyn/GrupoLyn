// Datos de demostración del panel de marketing para el entorno LOCAL (nunca producción): gasto, leads y
// llamadas evaluadas inventados, con campañas y anuncios marcados «DEMO». Se rehace en cada ejecución.
//   npx tsx --env-file=.env scripts/marketing-demo.ts          crea los datos
//   npx tsx --env-file=.env scripts/marketing-demo.ts --borrar  los borra
import pg from 'pg';

const url = process.env.DATABASE_URL || '';
if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) {
  console.error('Solo se ejecuta contra una base de datos local (DATABASE_URL en 127.0.0.1 o localhost).');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url });

let seed = 11;
const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const DEMO_CALL = 'demo-marketing-';

async function borrar() {
  await pool.query(`DELETE FROM mk_gasto_diario WHERE campana LIKE 'DEMO%'`);
  await pool.query(`DELETE FROM mk_lead WHERE lead_hash LIKE 'demo%'`);
  await pool.query(`DELETE FROM mk_carga WHERE detalle = 'demo'`);
  await pool.query(`DELETE FROM netelip_calls WHERE external_id LIKE '${DEMO_CALL}%'`); // borra sus evaluaciones en cascada
  await pool.query(`DELETE FROM comercial_rol WHERE extension_netelip IN ('920','915')`);
}

async function crear() {
  const campanas = [
    { canal: 'meta', id: 'demo-m1', nombre: 'DEMO alicante Integral · Captación', anuncios: [['120200000000001', 'Casa Idan · reel'], ['120200000000002', 'Reformas de cocinas · antes y después'], ['120200000000003', 'Reformas de cocinas · antes y después']] },
    { canal: 'meta', id: 'demo-m2', nombre: 'DEMO murcia Integral · Captación', anuncios: [['120200000000011', 'Reel Hooks Abril'], ['120200000000012', 'AT4 · control de la reforma']] },
    { canal: 'meta', id: 'demo-m3', nombre: 'DEMO Costa Sureste', anuncios: [['120200000000021', 'Tu hogar como siempre lo soñaste']] },
    { canal: 'google', id: 'demo-g1', nombre: 'DEMO Alicante Búsqueda integrales', anuncios: [] },
    { canal: 'google', id: 'demo-g2', nombre: 'DEMO Murcia Búsqueda integrales', anuncios: [] },
  ];
  const letras = ['A++', 'A+', 'A', 'B', 'C', 'D', 'No apto'];
  const hoy = Date.now();
  const desde = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 7, 1);
  const gasto: unknown[][] = [], leads: unknown[][] = [];
  let n = 0;
  for (let t = desde; t < hoy - 864e5; t += 864e5) {
    const fecha = new Date(t).toISOString().slice(0, 10);
    const madurez = Math.min(1, (hoy - t) / 864e5 / 75);
    const atribuido = hoy - t < 120 * 864e5; // la atribución por UTM «se activó» hace 4 meses
    for (const c of campanas) {
      for (const [anuncioId, anuncio] of c.anuncios.length ? c.anuncios : [['', '']]) {
        gasto.push([fecha, c.canal, c.id, c.nombre, c.anuncios.length ? 'demo-s1' : '', c.anuncios.length ? 'Ren' : '', anuncioId, anuncio,
          Math.round((c.canal === 'google' ? 48 : 21) * (0.6 + r() * 0.8) * 100) / 100, Math.round(20 + r() * 40), Math.round(1500 + r() * 3000)]);
        if (r() > (c.canal === 'google' ? 0.42 : 0.5)) continue;
        const letra = r() < 0.15 ? null : letras[Math.min(6, Math.floor(r() * r() * 6 + r() * 2))];
        const visita = r() < 0.32 * madurez, diseno = visita && r() < 0.55 * madurez, seg = diseno && r() < 0.6 * madurez, ganado = seg && r() < 0.35 * madurez;
        leads.push([`demo${String(++n).padStart(5, '0')}`, new Date(t + 9 * 3600e3 + r() * 10 * 3600e3), c.canal, c.canal === 'meta' ? '3' : '2',
          atribuido ? c.nombre : null, atribuido ? 'Ren' : null, atribuido ? anuncio || null : null,
          letra, letra && r() < 0.8 ? letra : null, Math.round(30 + r() * 120) * 1000, visita, diseno, seg, ganado]);
      }
    }
    if (r() < 0.25) leads.push([`demo${String(++n).padStart(5, '0')}`, new Date(t + 12 * 3600e3), 'tally', '1', null, null, null, 'B', 'B', 60000, r() < 0.4, false, false, false]);
  }
  const col = (rows: unknown[][], i: number) => rows.map((x) => x[i]);
  await pool.query(
    `INSERT INTO mk_gasto_diario (fecha, canal, campana_id, campana, conjunto_id, conjunto, anuncio_id, anuncio, gasto, clics, impresiones)
     SELECT * FROM UNNEST($1::date[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::numeric[], $10::int[], $11::int[])`,
    Array.from({ length: 11 }, (_, i) => col(gasto, i)));
  await pool.query(
    `INSERT INTO mk_lead (lead_hash, fecha_alta, canal, canal_origen, utm_campaign, utm_term, utm_content, letra_entrada, letra_confirmada, importe_estimado,
                          llego_visita, llego_diseno, llego_seguimiento, llego_ganado)
     SELECT * FROM UNNEST($1::text[], $2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::numeric[],
                          $11::bool[], $12::bool[], $13::bool[], $14::bool[])`,
    Array.from({ length: 14 }, (_, i) => col(leads, i)));

  // Nota comercial: un SDR (F0) y un closer (F2) inventados, con llamadas evaluadas en los últimos 13 meses.
  await pool.query(`INSERT INTO comercial_rol (extension_netelip, nombre, rol) VALUES ('920','SDR (demo)','sdr'), ('915','Closer (demo)','closer_f2') ON CONFLICT DO NOTHING`);
  let llamadas = 0;
  for (let t = hoy - 395 * 864e5; t < hoy - 864e5; t += 864e5) {
    for (const [ext, rol, base, p] of [['920', 'sdr', 74, 0.8], ['915', 'closer_f2', 80, 0.4]] as const) {
      if (r() > p) continue;
      const mes = (hoy - t) / (30 * 864e5);
      const { rows: [call] } = await pool.query(
        `INSERT INTO netelip_calls (external_id, direction, occurred_at, started_at_source, counterpart_phone, contact_status, agent_extension, duration_seconds, call_status, audio_ref, received_at)
         VALUES ($1, 'outbound', $2, 'uniqueid', 'anonymous', 'hidden', $3, $4, 'answered', 'demo', $2) RETURNING id`,
        [`${DEMO_CALL}${++llamadas}`, new Date(t + 10 * 3600e3), ext, 120 + Math.round(r() * 900)]);
      const evaluada = r() < 0.9;
      await pool.query(
        `INSERT INTO llamada_evaluacion (llamada_id, extension_netelip, rol, estado, nota, version_rubrica) VALUES ($1, $2, $3, $4, $5, 'demo')`,
        [call.id, ext, rol, evaluada ? 'evaluada' : 'no_evaluada', evaluada ? Math.round(Math.min(98, base + (12 - mes) * 0.6 + (r() - 0.5) * 18)) : null]);
    }
  }
  await pool.query(`INSERT INTO mk_carga (fuente, fin, estado, filas, detalle) VALUES ('windsor', NOW(), 'ok', $1, 'demo'), ('clickup', NOW(), 'ok', $2, 'demo')`, [gasto.length, leads.length]);
  console.log(JSON.stringify({ gasto: gasto.length, leads: leads.length, llamadas }));
}

try {
  await borrar();
  if (!process.argv.includes('--borrar')) await crear();
  else console.log('Datos de demostración borrados.');
} finally {
  await pool.end();
}
