import { describe, expect, it } from 'vitest';
import { calcularCategoria } from '../netelip/captacion/agregacion.ts';
import { CRITERIOS_IDS, MATRIZ_V1, type CriterioConfig, type CriterioId, type NivelONE } from '../netelip/captacion/matriz.ts';
import { valorVigenteDe } from '../netelip/captacion/motor.ts';
import { EJEMPLOS, ESQUEMA_SALIDA, promptSistema, promptUsuario, VERSION_PROMPT } from '../netelip/captacion/prompt.ts';
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

  // Hoy mide unos 12.900 caracteres (≈ 3.800 tokens); el ticket estimaba ≈ 1.500. El tope avisa si crece más.
  it('no crece sin control', () => {
    expect(prompt.length).toBeLessThan(14_000);
  });

  it('es la versión v2 y dice qué importes NO son el presupuesto del lead (12/11, pedido de Jean)', () => {
    expect(VERSION_PROMPT).toBe('captacion-v2');
    // La horquilla de LYN se registra solo como referencia.
    expect(prompt).toContain('esa NO es el presupuesto del lead: se guarda solo como referencia');
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
    expect(Object.keys(ESQUEMA_SALIDA.properties)).toEqual(['interaccion_id', 'presupuesto', 'presupuesto_insuficiente_sin_solucion', 'criterios', 'resumen']);
  });

  it('el prompt de usuario lleva el id, el sentido, la fecha, la duración y la transcripción', () => {
    const p = promptUsuario({ interaccionId: 'call-9', direccion: 'outbound', fecha: '2026-11-12', duracionSegundos: 185, transcripcion: '[00:00:01] CLIENTE: Hola.' });
    expect(p).toBe('Contexto: interaccion_id call-9 · llamada saliente del 2026-11-12 · 3 min\n\nTranscripción:\n[00:00:01] CLIENTE: Hola.');
    expect(promptUsuario({ interaccionId: 'x', direccion: 'inbound', fecha: '2026-11-12', duracionSegundos: 10, transcripcion: '' })).toContain('llamada entrante del 2026-11-12 · 1 min');
  });
});
