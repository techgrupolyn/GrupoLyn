import { describe, expect, it, vi } from 'vitest';
import { createPhonePrefixInference, inferPhoneFromSenders, phonePrefixCandidatesQuery } from '../phone-prefix.ts';

describe('Prefijo inferido de remitentes verificados', () => {
  it('acepta un único número internacional completo sin inventar país', () => {
    expect(inferPhoneFromSenders('600 123 456', ['34600123456', '34600123456'])).toBe('+34600123456');
    expect(inferPhoneFromSenders('0412 1234567', ['584121234567'])).toBe('+584121234567');
    expect(inferPhoneFromSenders('600 123 456', [])).toBeNull();
  });
  it('rechaza números inválidos, coincidencias parciales y remitentes arbitrarios', () => {
    expect(inferPhoneFromSenders('600123456', ['34600123457'])).toBeNull();
    expect(inferPhoneFromSenders('4125550123', ['14125550123', '584125550123'])).toBeNull();
    expect(inferPhoneFromSenders('600123456', ['999999999999999', '600123456'])).toBeNull();
    expect(inferPhoneFromSenders('600123456 ext 9', ['34600123456'])).toBeNull();
  });
  it('consulta solo remitentes entrantes con contenido de grupos Proyecto activos', () => {
    expect(phonePrefixCandidatesQuery).toContain("chat.nombre ~ '^Proyecto[[:space:]]+[^[:space:]]'");
    expect(phonePrefixCandidatesQuery).toContain('account.activo=TRUE');
    expect(phonePrefixCandidatesQuery).toContain('message.enviado_por_mi=FALSE');
    expect(phonePrefixCandidatesQuery).toContain("message.source='evolution'");
    expect(phonePrefixCandidatesQuery).not.toContain('message.texto AS');
  });
  it('reutiliza durante un minuto la lista leída en transacción de solo lectura', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) =>
      sql === phonePrefixCandidatesQuery ? { rows: [{ sender: '34600123456' }] } :
        sql.includes('AS fresh') ? { rows: [{ fresh: true }] } : { rows: [] });
    const release = vi.fn();
    const connect = vi.fn().mockResolvedValue({ query, release });
    let now = 1000;
    const infer = createPhonePrefixInference({ connect } as unknown as Parameters<typeof createPhonePrefixInference>[0], () => now);
    expect(await infer('600123456', ['allowed'])).toBe('+34600123456');
    expect(await infer('600123456', ['allowed'])).toBe('+34600123456');
    expect(connect).toHaveBeenCalledTimes(1);
    now += 60001;
    expect(await infer('600123456', ['allowed'])).toBe('+34600123456');
    expect(connect).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[3][1]).toEqual([['allowed']]);
    expect(release).toHaveBeenCalledTimes(2);
  });
});
