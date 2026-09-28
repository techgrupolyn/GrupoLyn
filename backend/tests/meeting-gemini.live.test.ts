import 'dotenv/config';
import { describe, expect, it } from 'vitest';
import { callGeminiWithPromptResult } from '../geminiService.ts';
import { meetingAiPrompt, parseMeetingAiAnalysis } from '../server.ts';

describe.skipIf(process.env.QA_LIVE_GEMINI !== 'true')('QA opt-in con Gemini real y datos exclusivamente sintéticos', () => {
  it('conserva tarea ambigua, información relevante y minutos sin inventar asignaciones', async () => {
    const source = `Archivo de prueba sintético. Reunión semanal obras. Fecha: 2026/09/25.
[00:01:10] Ana: Hay que mandar al cliente el plano de iluminación revisado de Mirador 9. Todavía no sabemos quién lo hace ni cuándo.
[00:02:02] Marta: Alguien tiene que llamar a la comunidad de vecinos para avisar del ruido. No sé en cuál de las dos obras hace falta ni quién lo hará.
[00:03:15] Ana: El proveedor de sanitarios sube precios un 5 % a partir de octubre. Es información, no hay ninguna tarea al respecto.
[00:04:20] Marta: Decidimos mantener la distribución de la cocina de Mirador 9 sin cambios.
[00:05:00] Ana: La entrega de carpintería está retrasada; impide empezar el montaje.
No se menciona a ningún PMC ni se asigna ninguna persona a las tareas.`;
    const prompt = meetingAiPrompt(source, { meetingKind: 'MEET', pmc: null, projectName: null, contactName: null }, '2026-09-25');
    const result = await callGeminiWithPromptResult(prompt, 'flash', 'Analiza los hechos y devuelve únicamente el JSON solicitado.', 60000, source);
    expect(result.fallback, 'El proveedor real no respondió; un fallback NO acredita QA de IA').toBe(false);
    const analysis = parseMeetingAiAnalysis(result.text);
    expect(analysis).not.toBeNull();
    expect(analysis!.meetingKind).toBe('MEET');
    expect(analysis!.pmc).toBeNull();
    const community = analysis!.actions.find((action) => /comunidad|vecinos/i.test(action.title));
    expect(community).toBeDefined();
    expect(community!.responsible).toBeNull();
    expect(community!.projectName).toBeNull();
    expect(community!.dueDate).toBeNull();
    expect(community!.sourceRef).toMatch(/02:02/);
    expect(analysis!.relevantInformation.join(' ')).toMatch(/5\s*%/);
    expect(analysis!.decisions.join(' ')).toMatch(/cocina|distribución/);
    expect(analysis!.blockers.length).toBeGreaterThan(0);
  }, 90000);
});
