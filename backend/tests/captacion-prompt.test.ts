import { describe, expect, it } from 'vitest';
import { calcularCategoria } from '../netelip/captacion/agregacion.ts';
import { CRITERIOS_IDS, MATRIZ_V1, type CriterioConfig, type CriterioId, type NivelONE } from '../netelip/captacion/matriz.ts';
import { valorVigenteDe } from '../netelip/captacion/motor.ts';
import { leerDecisionIA, verificarDecisionIA } from '../netelip/captacion/decision.ts';
import { agruparMotivos, bloqueResumenAnterior, CONTEXTO_POR_DEFECTO, EJEMPLOS, ESQUEMA_SALIDA, promptSistema, promptUsuario, VERSION_PROMPT } from '../netelip/captacion/prompt.ts';
import { MAX_CARACTERES_RESUMEN, renderResumen, validarResumen } from '../netelip/captacion/resumen.ts';
import { validarSalidaModelo, verificarSalida } from '../netelip/captacion/salida-modelo.ts';

/** Pasa un ejemplo del prompt por el mismo camino que una llamada real y devuelve lo que decidiría el código. */
const evaluarEjemplo = (i: number) => {
  const e = EJEMPLOS[i];
  if (!e) throw new Error(`no existe el ejemplo ${i}`);
  const id = String(e.salida.interaccion_id);
  const v = verificarSalida(validarSalidaModelo(JSON.stringify(e.salida), id), e.transcripcion.join('\n'));
  const niveles = Object.fromEntries(CRITERIOS_IDS.map((c) => [c, v.criterios[c].nivel])) as Record<CriterioId, NivelONE>;
  const presupuesto = v.presupuesto ? valorVigenteDe({ tipo: v.presupuesto.tipo, valorMin: v.presupuesto.min, valorMax: v.presupuesto.max }) : null;
  return { v, niveles, presupuesto, r: calcularCategoria({ niveles, noApto: v.noApto.valor, presupuestoVigente: presupuesto }) };
};

describe('ejemplos del prompt (few-shot)', () => {
  it('cada ejemplo cumple el contrato y todas sus citas están literalmente en su transcripción', () => {
    EJEMPLOS.forEach((e, i) => {
      const { v } = evaluarEjemplo(i);
      expect(v.descartes, e.titulo).toEqual([]);
      expect(v.revisionManual, e.titulo).toEqual([]);
      expect(e.contexto).toContain(`interaccion_id ${String(e.salida.interaccion_id)}`);
    });
  });

  it('ejemplo 1 · lead claro: rango del cliente, Urgencia A y categoría A+', () => {
    const { v, niveles, presupuesto, r } = evaluarEjemplo(0);
    expect(v.presupuesto).toMatchObject({ tipo: 'rango', min: 90000, max: 110000, emisor: 'cliente' });
    expect(presupuesto).toBe(100000);
    expect(niveles).toMatchObject({ presupuesto: 'A', urgencia: 'A', decisor: 'A', actitud: 'NE' });
    expect(r).toMatchObject({ categoria: 'A+', puntuacion: 4, cobertura: 90 });
  });

  it('ejemplo 2 · dudas de pareja (Decisor C), compara precio (Encaje C), «tengo que comentarlo en casa» (F2/F3 C) y sin presupuesto', () => {
    const { v, niveles, r } = evaluarEjemplo(1);
    expect(v.presupuesto).toBeNull();
    expect(niveles).toMatchObject({ decisor: 'C', encaje_lyn: 'C', predisposicion_f2f3: 'C', urgencia: 'C', alcance: 'D', presupuesto: 'NE' });
    expect(r).toMatchObject({ categoria: 'C', puntuacion: 1.85, cobertura: 65 });
  });

  it('ejemplo 3 · presupuesto insuficiente sin solución: No apto, y la orientación genérica de LYN no cuenta como presupuesto', () => {
    const { v, presupuesto, r } = evaluarEjemplo(2);
    expect(v.noApto.valor).toBe(true);
    expect(v.presupuesto).toMatchObject({ tipo: 'exacto', emisor: 'cliente' });
    expect(presupuesto).toBe(25000);
    expect(r.categoria).toBe('no_apto');
  });

  it('ejemplo 4 · rango que da LYN: emisor lyn y valor vigente 70.000 €', () => {
    const { v, presupuesto, r } = evaluarEjemplo(3);
    expect(v.presupuesto).toMatchObject({ tipo: 'rango', min: 60000, max: 80000, emisor: 'lyn' });
    expect(presupuesto).toBe(70000);
    expect(r).toMatchObject({ categoria: 'sin_calificar', cobertura: 30 });
  });
});

describe('prompt de sistema', () => {
  const prompt = promptSistema();

  it('lleva la versión y la regla «sin evidencia, NE»', () => {
    expect(prompt).toContain(VERSION_PROMPT);
    expect(prompt).toContain('sin evidencia, NE');
  });

  it('incluye, dentro de los delimitadores, los descriptores literales de los 7 criterios', () => {
    const dentro = prompt.slice(prompt.indexOf('<matriz>'), prompt.indexOf('</matriz>'));
    expect(dentro.length).toBeGreaterThan(0);
    for (const c of MATRIZ_V1) {
      expect(dentro).toContain(c.criterioId);
      for (const d of Object.values(c.descriptores)) expect(dentro).toContain(d);
    }
  });

  it('se arma desde la configuración: un descriptor nuevo aparece en el prompt', () => {
    const matriz: CriterioConfig[] = MATRIZ_V1.map((c) =>
      c.criterioId === 'decisor' ? { ...c, descriptores: { ...c.descriptores, A: 'Decide una sola persona' } } : c,
    );
    expect(promptSistema(matriz)).toContain('Decide una sola persona');
    expect(prompt).not.toContain('Decide una sola persona');
  });

  it('no le pide al modelo la categoría global ni menciona los pesos', () => {
    expect(prompt).toContain('No calculas ninguna categoría global');
    expect(prompt).not.toMatch(/25 ?%/);
  });

  it('explica los formatos de cifra y los cuatro tipos de presupuesto', () => {
    for (const t of ['«40k»', '«cuarenta mil»', '«40.000 €»', '40000', 'exacto', 'rango', 'abierto_superior', 'abierto_inferior']) {
      expect(prompt).toContain(t);
    }
  });

  it('incluye los ejemplos con su salida en JSON válido', () => {
    expect(prompt.match(/### Ejemplo \d+:/g)).toHaveLength(EJEMPLOS.length);
    for (const e of EJEMPLOS) expect(prompt).toContain(JSON.stringify(e.salida));
  });

  // Hoy mide unos 26.800 caracteres (≈ 8.000 tokens): con el resumen de N-1.3 y la decisión de pase de N-1.4 (reglas, manual provisional,
  // motivos y 6 ejemplos). Con el guion real (≈ 9.000 palabras) crecerá: el ticket pide condensarlo por pasos. El tope avisa si crece más.
  it('no crece sin control', () => {
    expect(prompt.length).toBeLessThan(28_000);
  });

  it('es la versión v5: cuentan los dos canales y se dice qué importes NO son el presupuesto del lead (13/11, pedido de Jean)', () => {
    expect(VERSION_PROMPT).toBe('captacion-v5');
    // La horquilla que da el comercial cuenta aunque el cliente solo diga que sí.
    expect(prompt).toContain('Los dos canales cuentan');
    expect(prompt).toContain('aunque el cliente solo conteste «sí» o «me parece bien» sin repetir la cifra');
    expect(prompt).not.toContain('se guarda solo como referencia');
    // Una cifra de unos pocos cientos de euros es una ampliación o un extra.
    expect(prompt).toContain('«son 100 euros más»');
    // El precio de un producto, una partida, una ampliación o un extra suelto no cuenta.
    expect(prompt).toContain('el precio de un producto, una partida, una ampliación o un extra suelto');
    expect(prompt).toContain('«una ampliación te costaría 500 más»');
    expect(prompt).toContain('ni un importe que sea solo una PARTE de la obra');
    // Lo del lead sigue siendo lo normal.
    expect(prompt).toContain('Lo normal es lo que dice el lead (emisor "cliente")');
  });
});

describe('esquema de salida y prompt de usuario', () => {
  it('el esquema exige los 7 criterios y Urgencia pide el plazo, no el nivel', () => {
    expect(ESQUEMA_SALIDA.properties.criterios.required).toEqual([...CRITERIOS_IDS]);
    const urgencia = ESQUEMA_SALIDA.properties.criterios.properties.urgencia as { properties: Record<string, unknown> };
    expect(Object.keys(urgencia.properties)).toEqual(['plazo_meses', 'cita', 'marca_tiempo']);
    const decisor = ESQUEMA_SALIDA.properties.criterios.properties.decisor as { properties: Record<string, unknown> };
    expect(Object.keys(decisor.properties)).toEqual(['nivel', 'cita', 'marca_tiempo']);
  });

  it('el esquema no deja sitio para una categoría global', () => {
    expect(Object.keys(ESQUEMA_SALIDA.properties)).toEqual(['interaccion_id', 'presupuesto', 'presupuesto_insuficiente_sin_solucion', 'criterios', 'resumen', 'decision_ia']);
  });

  it('el prompt de usuario lleva el id, el sentido, la fecha, la duración y la transcripción', () => {
    const p = promptUsuario({ interaccionId: 'call-9', direccion: 'outbound', fecha: '2026-11-12', duracionSegundos: 185, transcripcion: '[00:00:01] CLIENTE: Hola.' });
    expect(p).toBe('Contexto: interaccion_id call-9 · llamada saliente del 2026-11-12 · 3 min\nResumen anterior del lead: ninguno (es la primera llamada procesada).\n\nTranscripción:\n[00:00:01] CLIENTE: Hola.');
    expect(promptUsuario({ interaccionId: 'x', direccion: 'inbound', fecha: '2026-11-12', duracionSegundos: 10, transcripcion: '' })).toContain('llamada entrante del 2026-11-12 · 1 min');
  });

  it('el prompt de usuario lleva el resumen anterior del lead, con sus cuatro líneas etiquetadas', () => {
    const resumenAnterior = { queQuiere: 'Reforma integral', dondeQuedo: 'Cita en oficina', queLoFrena: 'Sin información', paraQueLlamarlo: 'Confirmar la cita', fechaPrevista: null };
    const p = promptUsuario({ interaccionId: 'c', direccion: 'outbound', fecha: '2026-11-12', duracionSegundos: 60, transcripcion: 'T', resumenAnterior });
    expect(p).toContain('Resumen anterior del lead (actualízalo con esta llamada):\nQué quiere: Reforma integral\nDónde quedó: Cita en oficina\nQué lo frena: Sin información\nPara qué llamarlo: Confirmar la cita\n');
    expect(p).not.toContain('ninguno');
    expect(promptUsuario({ interaccionId: 'c', direccion: 'outbound', fecha: '2026-11-12', duracionSegundos: 60, transcripcion: 'T', resumenAnterior: null })).toContain('ninguno (es la primera llamada procesada)');
  });
});

// N-1.3 · el resumen ejecutivo en el prompt y en los ejemplos.
describe('resumen ejecutivo en el prompt (N-1.3)', () => {
  const prompt = promptSistema();
  const fechaDe = (contexto: string): string => /llamada \w+ del (\d{4}-\d{2}-\d{2})/.exec(contexto)![1]!;

  it('el esquema pide la cita de la fecha prevista junto a la fecha', () => {
    const r = ESQUEMA_SALIDA.properties.resumen;
    expect(r.required).toEqual(['que_quiere', 'donde_quedo', 'que_lo_frena', 'para_que_llamarlo', 'fecha_prevista', 'fecha_prevista_cita']);
    expect(Object.keys(r.properties)).toContain('fecha_prevista_cita');
  });

  it('cada ejemplo trae un resumen que el código acepta tal cual, con su transcripción y dentro de los 600 caracteres', () => {
    EJEMPLOS.forEach((e) => {
      const s = validarSalidaModelo(JSON.stringify(e.salida), String(e.salida.interaccion_id));
      const v = validarResumen(s.resumen, {
        transcripcion: e.transcripcion.join('\n'),
        fechaLlamada: fechaDe(e.contexto),
        tienePresupuesto: s.presupuesto !== null,
      });
      expect(v.ok, e.titulo).toBe(true);
      if (v.ok) {
        // Lo que el modelo escribió ya es lo que se guarda, salvo lo que el código añade solo («Preguntar presupuesto», «sin fecha acordada»).
        expect(v.resumen.queQuiere, e.titulo).toBe(s.resumen.queQuiere);
        expect(renderResumen(v.resumen).length, e.titulo).toBeLessThanOrEqual(MAX_CARACTERES_RESUMEN);
        expect(renderResumen(v.resumen).split('\n'), e.titulo).toHaveLength(4);
      }
    });
  });

  it('los ejemplos cubren los tres casos del ticket: primera llamada, seguimiento con acuerdos (con fecha y resumen anterior) y lead con objeciones', () => {
    expect(EJEMPLOS[0]!.resumenAnterior).toBeUndefined();
    expect(EJEMPLOS[0]!.salida.resumen).toMatchObject({ fecha_prevista: '2026-11-12' });
    expect(EJEMPLOS[1]!.salida.resumen).toMatchObject({ que_lo_frena: expect.stringContaining('compara precios') });
    const seguimiento = EJEMPLOS[4]!;
    expect(seguimiento.resumenAnterior).toBeDefined();
    expect(seguimiento.salida.resumen).toMatchObject({ fecha_prevista: '2026-11-20', fecha_prevista_cita: expect.stringContaining('viernes 20') });
    expect(prompt).toContain(bloqueResumenAnterior(seguimiento.resumenAnterior));
    expect(prompt.match(/Resumen anterior del lead: ninguno/g)).toHaveLength(EJEMPLOS.length - 1);
  });

  it('el prompt dice las reglas del resumen: sin importes ni datos de contacto, «Sin información», fecha con su cita y lo que añade el sistema', () => {
    for (const t of [
      'ACTUALIZACIÓN',
      'NUNCA pongas importes ni cifras de dinero',
      'NUNCA pongas teléfonos, emails, direcciones',
      'exactamente «Sin información»',
      'fecha_prevista_cita',
      'La fecha nunca se inventa',
      'el sistema los añade',
    ]) expect(prompt, t).toContain(t);
  });
});


// N-1.4 · la decisión de pase de la IA en el prompt y en los ejemplos.
describe('decisión de pase en el prompt (N-1.4)', () => {
  const prompt = promptSistema();
  const motivosPorDefecto = CONTEXTO_POR_DEFECTO.motivos;

  it('el esquema pide decision_ia, que puede ser null, con decisión, motivos con cita, excepciones, dudas, «pendiente de Ernesto» y pasos', () => {
    const d = ESQUEMA_SALIDA.properties.decision_ia;
    expect(d.type).toEqual(['object', 'null']);
    expect(d.required).toEqual(['decision', 'motivos', 'excepciones', 'dudas', 'pendiente_ernesto', 'proximos_pasos']);
    expect(d.properties.decision.enum).toEqual(['pasar_a_reunion', 'derivar_partners', 'seguimiento', 'descartar']);
    expect(d.properties.proximos_pasos.items.required).toEqual(['orden', 'accion', 'cuando', 'canal', 'que_pedir', 'requiere_ernesto', 'cita']);
    expect(d.properties.proximos_pasos.items.properties.canal.enum).toEqual(['llamada', 'whatsapp', 'email']);
    expect(d.properties.proximos_pasos.items.properties.cuando.properties.tipo.enum).toEqual(['fecha_cliente', 'plazo_guion']);
    expect(ESQUEMA_SALIDA.required).toContain('decision_ia');
  });

  it('cada ejemplo trae una decisión que el código acepta tal cual: citas literales de su transcripción, motivos de la lista y a lo sumo 3 pasos', () => {
    EJEMPLOS.forEach((e) => {
      const bruta = leerDecisionIA(e.salida.decision_ia);
      expect(bruta, e.titulo).not.toBeNull();
      const v = verificarDecisionIA(bruta!, e.transcripcion.join('\n'), motivosPorDefecto);
      expect(v.ok, e.titulo).toBe(true);
      if (!v.ok) return;
      expect(v.descartes, e.titulo).toEqual([]);
      expect(v.decision.motivos.length, e.titulo).toBeGreaterThan(0);
      expect(v.decision.motivos.every((m) => m.codigo !== 'otro'), e.titulo).toBe(true);
      expect(v.decision.pendienteErnesto, e.titulo).toBeNull();
      expect(v.decision.proximosPasos.length, e.titulo).toBeLessThanOrEqual(3);
    });
  });

  it('los ejemplos cubren las cuatro decisiones, un seguimiento que no escala por faltar un dato y una excepción que «requiere Ernesto»', () => {
    const porEjemplo = EJEMPLOS.map((e) => e.salida.decision_ia as { decision: string; excepciones: string[]; proximos_pasos: Array<{ requiere_ernesto: boolean }> });
    expect(new Set(porEjemplo.map((d) => d.decision))).toEqual(new Set(['pasar_a_reunion', 'seguimiento', 'descartar']));
    const ej6 = porEjemplo[5]!;
    expect(ej6).toMatchObject({ decision: 'seguimiento', excepciones: ['topografo'] });
    expect(ej6.proximos_pasos.map((p) => p.requiere_ernesto)).toEqual([false, true]);
    // Falta el plano (un dato del cliente): seguimiento, y la excepción es otra cosa (alguien que vaya a medir).
    expect(JSON.stringify(EJEMPLOS[5]!.salida.decision_ia)).toContain('falta_dato_cliente');
  });

  it('el ejemplo de seguimiento: primer paso a partir del día 20 con la cita que lo justifica (Escenario «Próximos pasos en seguimiento»)', () => {
    const ej6 = EJEMPLOS[5]!.salida.decision_ia as { proximos_pasos: Array<{ orden: number; cuando: { tipo: string; valor: string }; canal: string; cita: string; que_pedir: string }> };
    expect(ej6.proximos_pasos[0]).toMatchObject({ orden: 1, cuando: { tipo: 'fecha_cliente', valor: 'a partir del 20 de noviembre' }, canal: 'llamada', cita: 'Vuelvo el 20 de noviembre', que_pedir: 'el plano' });
  });

  it('el prompt lleva las reglas de la decisión, los motivos por decisión, el guion y el manual con su versión', () => {
    for (const t of [
      '## Decisión de pase del SDR (objeto `decision_ia`)',
      'Decides POR TU CUENTA, sin conocer la propuesta del SDR',
      'Si el contexto dice que el lead ya está en F2 o más allá, `decision_ia` es null.',
      'no se escala por eso',
      'Una fecha solo si el cliente la dio',
      'Es una recomendación: no crea avisos, tareas ni mensajes ni mueve al lead de fase.',
      '### Motivos permitidos por decisión',
      'seguimiento: falta_dato_cliente (Falta un dato del cliente)',
      'descartar: presupuesto_insuficiente (Presupuesto insuficiente)',
      '### Guion del SDR (versión 1)',
      '### Manual de reglas (versión 1)',
      'Ante la mínima duda que pueda cambiar esa conclusión',
    ]) expect(prompt, t).toContain(t);
  });

  it('el guion, el manual y los motivos salen del contexto que se le pasa (configurable, no fijo en el código)', () => {
    const ctx = {
      guion: { version: 7, texto: 'GUION SIETE' }, manual: { version: 3, texto: 'MANUAL TRES' },
      motivos: agruparMotivos([['seguimiento', 'solo_este', 'Solo este motivo']]),
    };
    const p = promptSistema(undefined, ctx);
    expect(p).toContain('### Guion del SDR (versión 7)\nGUION SIETE');
    expect(p).toContain('### Manual de reglas (versión 3)\nMANUAL TRES');
    expect(p).toContain('seguimiento: solo_este (Solo este motivo)');
    expect(p).toContain('descartar: (sin motivos configurados)');
    expect(p).not.toContain('falta_dato_cliente (Falta un dato del cliente)');
  });

  it('el prompt de usuario avisa de que un lead en F2 o más allá no genera decisión, y solo entonces', () => {
    const base = { interaccionId: 'c', direccion: 'outbound', fecha: '2026-11-12', duracionSegundos: 60, transcripcion: 'T' };
    expect(promptUsuario({ ...base, sinDecision: true })).toContain('\nDecisión de pase: no aplica, el lead ya está en F2 o más allá. Devuelve decision_ia null.');
    expect(promptUsuario({ ...base, sinDecision: false })).not.toContain('Decisión de pase');
    expect(promptUsuario(base)).not.toContain('Decisión de pase');
  });

  it('agruparMotivos deja las cuatro decisiones, aunque alguna no tenga motivos, y conserva el orden', () => {
    const m = agruparMotivos([['descartar', 'b', 'B'], ['descartar', 'a', 'A']]);
    expect(Object.keys(m)).toEqual(['pasar_a_reunion', 'derivar_partners', 'seguimiento', 'descartar']);
    expect(m.descartar.map((x) => x.codigo)).toEqual(['b', 'a']);
    expect(m.seguimiento).toEqual([]);
  });
});
