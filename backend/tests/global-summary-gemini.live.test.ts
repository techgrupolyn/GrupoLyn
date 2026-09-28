import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createSummaryQueue } from '../summary-jobs.ts';
import { resolveSpecialist } from '../geminiService.ts';

describe.skipIf(process.env.QA_LIVE_GLOBAL_GEMINI !== 'true')('Informe global con Gemini real y 20000 textos sintéticos', () => {
  it('termina, conserva las tareas de control, persiste el informe y descuenta solo la selección inicial', async () => {
    const databaseUrl = process.env.QA_TEST_DATABASE_URL || '';
    const target = new URL(databaseUrl);
    if (target.hostname !== '127.0.0.1' || target.port !== '55439' || target.pathname !== '/lyn_qa_global_gemini') throw new Error('Se requiere la base local dedicada lyn_qa_global_gemini en 55439');
    if (!process.env.GOOGLE_GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) throw new Error('No hay clave Gemini configurada');
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = 'test';
    process.env.SUPABASE_SYNC_ENABLED = 'false';
    process.env.EVOLUTION_BACKGROUND_SYNC_ENABLED = 'false';
    process.env.MEETING_AI_BACKGROUND_ANALYSIS_ENABLED = 'false';
    const systemPrompt = resolveSpecialist('general')!.system_prompt;
    const accountId = `qa-live-global-${randomUUID()}`;
    const specialistId = `qa-live-general-${randomUUID()}`;
    const invitationId = randomUUID();
    const activationId = randomUUID();
    const headers = { 'x-extension-activation': activationId };
    const started = Date.now();
    const evidence: Record<string, unknown> = { startedAt: new Date(started).toISOString(), syntheticOnly: true, requestedMessages: 20000, groups: 10, status: 'running' };
    const calls: Array<Record<string, unknown>> = [];
    const submittedIds = new Set<string>();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== 'https://generativelanguage.googleapis.com' || url.pathname !== '/v1beta/interactions') throw new Error('La prueba solo permite contactar Gemini Interactions');
      const body = JSON.parse(String(options?.body));
      const prompt = String(body.input);
      expect(prompt.length).toBeLessThan(50000);
      const leaf = prompt.startsWith('ETAPA: EXTRACCION');
      if (leaf) {
        const data = JSON.parse(prompt.split('DATOS_JSON:\n').at(-1)!);
        for (const source of data.primary) for (const identifier of source.line.match(/MSG\d{5}/g) || []) submittedIds.add(identifier);
      }
      const callStarted = Date.now();
      const response = await originalFetch(input, options);
      const payload = await response.clone().json() as Record<string, unknown>;
      calls.push({ index: calls.length + 1, status: response.status, model: body.model, promptChars: prompt.length, leaf, elapsedMs: Date.now() - callStarted, usage: payload.usage || null });
      console.log(`[qa-global-live] llamada=${calls.length} status=${response.status} textos_enviados=${submittedIds.size}/20000 ms=${Date.now() - callStarted}`);
      return response;
    };
    let server: typeof import('../server.ts') | undefined;
    let ticker: ReturnType<typeof setInterval> | undefined;
    let tickPending: Promise<void> | undefined;
    const pendingTasks: string[] = [];
    try {
      server = await import('../server.ts');
      const { pool } = server;
      await pool.query(await readFile(new URL('../../schema.sql', import.meta.url), 'utf8'));
      await server.ensureDatabaseSchema();
      expect((await pool.query("SELECT id FROM summary_jobs WHERE status IN ('queued','running')")).rowCount, 'No se ejecutan trabajos de otras pruebas').toBe(0);
      await pool.query('INSERT INTO whatsapp_accounts(id,nombre,evolution_instance_name) VALUES($1,$1,$1)', [accountId]);
      await pool.query("INSERT INTO especialistas(id,nombre,rol,sistema_prompt,modelo) VALUES($1,'Copiloto sintético QA','general',$2,'flash')", [specialistId, systemPrompt]);
      await pool.query("INSERT INTO extension_invitations(id,code_hash,expires_at,created_by,account_id) VALUES($1::uuid,$1::text,NOW()+INTERVAL '4 hours','qa-live',$2)", [invitationId, accountId]);
      await pool.query('INSERT INTO extension_activations(id,invitation_id,account_id) VALUES($1,$2,$3)', [activationId, invitationId, accountId]);
      for (let group = 0; group < 10; group++) {
        const label = String(group + 1).padStart(2, '0');
        const chatId = `${accountId}::1203638888000${label}@g.us`;
        await pool.query('INSERT INTO chats(id,account_id,nombre,unread_count,whatsapp_unread_count) VALUES($1,$2,$3,2000,2000)', [chatId, accountId, `Proyecto sintético ${label}`]);
        const texts = Array.from({ length: 2000 }, (_, index) => {
          const marker = `MSG${String(group * 2000 + index).padStart(5, '0')}`;
          let content = `Registro informativo ${index}: se revisó el parte diario sin incidencias. No se solicita ninguna acción nueva.`;
          if (index === 0) content = `Expediente INICIO-${label}: Paula debe enviar el plano el 2 de octubre de 2026.`;
          if (index === 1000) content = `Expediente MEDIO-${label}: Marta debe confirmar el presupuesto de 1200 euros antes del 5 de octubre de 2026. Sigue pendiente.`;
          if (group === 0 && index === 500) content = 'Expediente PAGO-01: El pago de 900 euros NO está autorizado; falta aprobación de Ana. No se ha pagado.';
          if (group === 0 && index === 1500) content = 'Expediente DUDA-01: Hay que llamar a la comunidad, pero no se ha asignado a nadie ni se ha indicado una fecha.';
          if (index === 1998) content = `Actualización INICIO-${label}: Paula ya envió el plano; tarea completada y cerrada, no requiere seguimiento.`;
          if (index === 1999) content = `Expediente FINAL-${label}: Luis debe pedir el permiso de acceso antes del 8 de octubre de 2026. Es un bloqueo pendiente.`;
          return `${marker} ${content}`;
        });
        pendingTasks.push(`MEDIO-${label}`, `FINAL-${label}`);
        await pool.query(`INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,timestamp,tipo,enviado_por_mi)
          SELECT $1 || ':' || entry.ordinality,$1,$2,'Participante sintético',entry.texto,
          TIMESTAMPTZ '2026-09-27T00:00:00Z' + entry.ordinality*INTERVAL '1 second','text',FALSE
          FROM unnest($3::text[]) WITH ORDINALITY entry(texto,ordinality)`, [chatId, accountId, texts]);
      }
      const submitted = await request(server.app).post('/api/chat/global-summary').set(headers).send({ specialistId });
      expect(submitted.status).toBe(202);
      const jobId = submitted.body.jobId;
      evidence.jobId = jobId;
      let arrivalInserted = false;
      let pollingFailure: unknown;
      ticker = setInterval(() => {
        if (tickPending) return;
        tickPending = (async () => {
          const response = await request(server!.app).get(`/api/chat/global-summary/jobs/${jobId}`).set(headers);
          expect(response.status).toBe(200);
          if (response.body.status === 'running') {
            const state = (await pool.query('SELECT status,(SELECT SUM(unread_count)::int FROM chats WHERE account_id=$1) AS total FROM summary_jobs WHERE id=$2', [accountId, jobId])).rows[0];
            if (state.status === 'running') expect(state.total).toBe(arrivalInserted ? 20001 : 20000);
            if (!arrivalInserted && response.body.progress?.completedBatches > 0) {
              const chatId = `${accountId}::120363888800001@g.us`;
              await pool.query("INSERT INTO mensajes(id,chat_id,account_id,remitente,texto,enviado_por_mi) VALUES($1,$2,$3,'Sintético','Mensaje posterior a la selección del informe',FALSE)", [`${accountId}:new`, chatId, accountId]);
              await pool.query('UPDATE chats SET unread_count=2001,whatsapp_unread_count=2001 WHERE id=$1', [chatId]);
              arrivalInserted = true;
            }
          }
        })().catch((error) => { pollingFailure = error; }).finally(() => { tickPending = undefined; });
      }, 3000);
      await createSummaryQueue(pool, server.prepareGlobalSummary).run();
      clearInterval(ticker);
      await tickPending;
      if (pollingFailure) throw pollingFailure;
      const completed = await request(server.app).get(`/api/chat/global-summary/jobs/${jobId}`).set(headers);
      evidence.job = completed.body;
      expect(completed.body.status, JSON.stringify(completed.body)).toBe('completed');
      expect(completed.body).toMatchObject({ mensajes_analizados: 20000, grupos_analizados: 10, mensajes_pendientes_restantes: 1 });
      expect(arrivalInserted).toBe(true);
      expect(submittedIds.size).toBe(20000);
      const summary = (await pool.query('SELECT * FROM resumenes_globales_chat WHERE account_id=$1', [accountId])).rows;
      expect(summary).toHaveLength(1);
      expect(summary[0]).toMatchObject({ ai_provider: 'gemini', ai_fallback: false, mensajes_contexto: 20000 });
      expect(new Set(summary[0].mensaje_ids).size).toBe(20000);
      evidence.report = summary[0].resumen;
      evidence.grounding = summary[0].evidence;
      for (const group of summary[0].evidence.groups) {
        const sources = new Map<string, { line: string; messageId: string }>(group.sources.map((source: { ref: string; line: string; messageId: string }) => [source.ref, source]));
        for (const finding of group.findings) for (const citation of finding.evidence) {
          expect(sources.has(citation.source)).toBe(true);
          expect(sources.get(citation.source)!.line).toContain(citation.quote);
          expect(summary[0].mensaje_ids).toContain(sources.get(citation.source)!.messageId);
        }
      }
      const firstGroup = summary[0].evidence.groups.find((group: { name: string }) => group.name === 'Proyecto sintético 01');
      const payment = firstGroup.findings.filter((finding: { topicRef: string }) => finding.topicRef === 'PAGO-01');
      expect(payment.length).toBeGreaterThan(0);
      expect(payment.every((finding: { text: string; state: string }) => /no|falta|pendiente|sin autoriz/i.test(finding.text) && finding.state !== 'completed')).toBe(true);
      const ambiguous = firstGroup.findings.filter((finding: { topicRef: string }) => finding.topicRef === 'DUDA-01');
      expect(ambiguous.length).toBeGreaterThan(0);
      expect(ambiguous.every((finding: { text: string }) => !/Marta|Paula|Luis|Ana/.test(finding.text))).toBe(true);
      evidence.semanticChecks = { paymentNegation: true, ambiguousAssigneeNotInvented: true, literalCitations: true };
      evidence.taskChecks = pendingTasks.map((reference) => ({ reference, present: summary[0].resumen.includes(reference) }));
      for (const reference of pendingTasks) expect(summary[0].resumen, `Debe conservar ${reference}`).toContain(reference);
      expect((await pool.query('SELECT COUNT(*)::int AS total FROM summary_reviewed_messages WHERE account_id=$1', [accountId])).rows[0].total).toBe(20000);
      expect((await pool.query('SELECT SUM(unread_count)::int AS unread,SUM(whatsapp_unread_count)::int AS whatsapp FROM chats WHERE account_id=$1', [accountId])).rows[0]).toEqual({ unread: 1, whatsapp: 20001 });
      expect((await pool.query('SELECT * FROM summary_job_contexts WHERE job_id=$1', [jobId])).rowCount).toBe(0);
      evidence.status = 'passed';
    } catch (error) {
      evidence.status = 'failed';
      evidence.failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (ticker) clearInterval(ticker);
      await tickPending;
      globalThis.fetch = originalFetch;
      evidence.elapsedMs = Date.now() - started;
      evidence.calls = calls;
      evidence.uniqueTextIdsSent = submittedIds.size;
      const directory = new URL('../../.runtime-logs/', import.meta.url);
      await mkdir(directory, { recursive: true });
      await writeFile(new URL('global-summary-grounded-gemini-live-evidence.json', directory), JSON.stringify(evidence, null, 2));
      if (server) {
        try {
          await server.pool.query('DELETE FROM resumenes_globales_chat WHERE account_id=$1', [accountId]);
          await server.pool.query('DELETE FROM summary_reviewed_messages WHERE account_id=$1', [accountId]);
          await server.pool.query('DELETE FROM chats WHERE account_id=$1', [accountId]);
          await server.pool.query('DELETE FROM extension_activations WHERE id=$1', [activationId]);
          await server.pool.query('DELETE FROM extension_invitations WHERE id=$1', [invitationId]);
          await server.pool.query('DELETE FROM whatsapp_accounts WHERE id=$1', [accountId]);
          await server.pool.query('DELETE FROM especialistas WHERE id=$1', [specialistId]);
        } finally { await server.pool.end(); }
      }
      console.log(`[qa-global-live] estado=${evidence.status} llamadas=${calls.length} mensajes=${submittedIds.size} duración_ms=${evidence.elapsedMs}`);
    }
  }, 3_600_000);
});
