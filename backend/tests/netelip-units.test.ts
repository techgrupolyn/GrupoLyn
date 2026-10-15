import { describe, expect, it } from 'vitest';
import { matchPhone, type DirectoryIndex } from '../netelip/contacts.ts';
import { nextCommand, type CallState, type ControlConfig } from '../netelip/control.ts';
import {
  bodyFields, callRecordingPayload, direction, eventFromPayload, IgnoredEvent, InvalidEvent, ipAllowed, isInternal,
  NETELIP_TRUSTED_NETWORKS, parseWhatsAppCall, startedAt, tokenMatches,
} from '../netelip/events.ts';
import { maskPhone, toE164 } from '../netelip/phone.ts';
import { parseReportDate, reportKey } from '../netelip/processing.ts';
import { madridDay, partiesFromRecording, parsePropfind, pickRecording } from '../netelip/vdrive.ts';
import { canAccessNetelipCalls, canReadTranscripts } from '../netelip/routes.ts';

const BASE = {
  uniqueid: '1791201600.1', src: '600111222', dst: '201', userexten: '201', status: 'ANSWERED', duration: '95',
  file: '/vdrive/rec/1791201600.1.mp3', URLAudio: 'https://vdrive.example/a', URLDownload: 'https://vdrive.example/d?token=x',
};

describe('Netelip · teléfonos', () => {
  it.each([
    ['638829213', '+34638829213'], ['34638829213', '+34638829213'], ['0034638829213', '+34638829213'],
    ['+34 638 82 92 13', '+34638829213'], ['910000000', '+34910000000'], ['00573001234567', '+573001234567'],
  ])('normaliza %s a E.164', (raw, expected) => expect(toE164(raw)).toBe(expected));

  it.each(['', 'anonymous', '123', 'Desconocido'])('rechaza %j', (raw) => expect(() => toE164(raw)).toThrow());

  it('enmascara teléfonos y deja las extensiones', () => {
    expect(maskPhone('+34638829213')).toBe('***213');
    expect(maskPhone('113')).toBe('113');
  });
});

describe('Netelip · evento callrecording', () => {
  it('acepta form-urlencoded, JSON plano y JSON anidado bajo callrecording', async () => {
    const form = new URLSearchParams(BASE).toString();
    const nested = `callrecording=${encodeURIComponent(JSON.stringify(BASE))}`;
    for (const body of [form, JSON.stringify(BASE), JSON.stringify({ callrecording: BASE }), nested]) {
      const event = eventFromPayload(callRecordingPayload(await bodyFields(body, 'application/x-www-form-urlencoded')));
      expect(event).toMatchObject({ uniqueid: '1791201600.1', duration: 95, status: 'ANSWERED', url_download: BASE.URLDownload });
    }
  });

  it('acepta multipart/form-data, como envía API Voice', async () => {
    const form = new FormData();
    for (const [key, value] of Object.entries(BASE)) form.append(key, value);
    const request = new Request('http://local', { method: 'POST', body: form });
    const body = Buffer.from(await request.arrayBuffer());
    const fields = await bodyFields(body, request.headers.get('content-type') || '');
    expect(eventFromPayload(callRecordingPayload(fields)).file).toBe(BASE.file);
  });

  it('ignora los índices call y register de API Voice', async () => {
    const fields = await bodyFields(`call=${encodeURIComponent(JSON.stringify({ status: 'RING' }))}`, undefined);
    expect(() => callRecordingPayload(fields)).toThrow(IgnoredEvent);
  });

  it('rechaza eventos sin campos obligatorios o con duración no numérica', () => {
    expect(() => eventFromPayload({ ...BASE, file: '' })).toThrow(/file/);
    expect(() => eventFromPayload({ ...BASE, duration: 'abc' })).toThrow(InvalidEvent);
  });

  it('deduce dirección, llamadas internas e inicio desde el uniqueid', () => {
    const inbound = eventFromPayload(BASE);
    expect(direction(inbound)).toBe('inbound');
    expect(direction({ src: '113' })).toBe('outbound');
    expect(isInternal({ src: '113', dst: '201' })).toBe(true);
    expect(startedAt(inbound, new Date()).at.toISOString()).toBe('2026-10-05T12:00:00.000Z');
    const received = new Date('2026-10-05T10:05:00Z');
    expect(startedAt({ ...inbound, uniqueid: 'x' }, received)).toEqual({ at: new Date('2026-10-05T10:03:25Z'), source: 'received_minus_duration' });
  });

  it('clave del informe: uniqueid o inicio + origen + destino', () => {
    expect(reportKey({ uniqueid: 'u1' })).toBe('u1');
    expect(reportKey({ ID: '1792090207.506672', startdate: '2026-10-15 20:50:07' })).toBe('1792090207.506672');
    expect(reportKey({ startdate: '2026-10-05 10:00:00', src: '600111222', dst: '201' })).toBe('rep:2026-10-05 10:00:00|600111222|201');
    expect(reportKey({ status: 'ANSWERED' })).toBeNull();
  });
});

describe('Netelip · vDrive e informe de llamadas', () => {
  const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
    <d:response><d:href>/remote.php/dav/files/u/APIVoice/Record/2026-10-15/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
    <d:response><d:href>/remote.php/dav/files/u/APIVoice/Record/2026-10-15/2026_10_15_23_37_31_113_0057300_1792100251.509034_announce.mp3</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response>
    <d:response><d:href>/remote.php/dav/files/u/APIVoice/Record/2026-10-15/2026_10_15_22_29_15_113_0057300_1792096155.508627.mp3</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response>
    <d:response><d:href>/remote.php/dav/files/u/APIVoice/Record/2026-10-15/2026_10_15_22_29_15_113_0057300_1792096155.508627_announce.mp3</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response>
  </d:multistatus>`;

  it('lista los ficheros de una carpeta de vDrive (sin la carpeta)', () => {
    expect(parsePropfind(xml)).toHaveLength(3);
  });

  it('elige la grabación de la llamada por su ID: sin aviso en mono y con aviso en estéreo o si es la única', () => {
    const names = parsePropfind(xml);
    const dir = '/APIVoice/Record/2026-10-15';
    expect(pickRecording(names, '1792096155.508627', false, dir)).toBe(`${dir}/2026_10_15_22_29_15_113_0057300_1792096155.508627.mp3`);
    expect(pickRecording(names, '1792096155.508627', true, dir)).toMatch(/508627_announce\.mp3$/);
    expect(pickRecording(names, '1792100251.509034', false, dir)).toMatch(/509034_announce\.mp3$/);
    expect(pickRecording(names, '1792100251.5090', false, dir)).toBeNull();
  });

  it('saca origen y destino del nombre del fichero de vDrive', () => {
    expect(partiesFromRecording('/APIVoice/Record/2026-10-15/2026_10_15_23_37_31_113_0057300000000_1792100251.509034_announce.mp3')).toEqual({ src: '113', dst: '0057300000000' });
    expect(partiesFromRecording('/x/otro.mp3')).toBeNull();
  });

  it('las fechas del informe y las carpetas de vDrive van en hora de Madrid', () => {
    expect(parseReportDate('2026-10-15 23:09:46.737705')?.toISOString()).toBe('2026-10-15T21:09:46.000Z');
    expect(parseReportDate('2026-12-01 10:00:00')?.toISOString()).toBe('2026-12-01T09:00:00.000Z');
    expect(madridDay(new Date('2026-10-15T22:30:00Z'))).toBe('2026-10-16');
  });
});

describe('Netelip · seguridad del receptor', () => {
  it('solo admite IP de las redes de Netelip', () => {
    expect(ipAllowed('185.8.244.10', NETELIP_TRUSTED_NETWORKS)).toBe(true);
    expect(ipAllowed('192.99.91.150', NETELIP_TRUSTED_NETWORKS)).toBe(true);
    expect(ipAllowed('::ffff:185.8.244.10', NETELIP_TRUSTED_NETWORKS)).toBe(true);
    expect(ipAllowed('192.99.91.160', NETELIP_TRUSTED_NETWORKS)).toBe(false);
    expect(ipAllowed('8.8.8.8', NETELIP_TRUSTED_NETWORKS)).toBe(false);
    expect(ipAllowed(undefined, NETELIP_TRUSTED_NETWORKS)).toBe(false);
    expect(ipAllowed('127.0.0.1', '')).toBe(false);
  });

  it('compara el token en tiempo constante y rechaza vacíos', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches('', '')).toBe(false);
  });
});

describe('Netelip · controlador de API Voice', () => {
  const cfg: ControlConfig = { avisoText: 'Esta llamada será grabada.', voice: 'Silvia', avisoAnnounce: 'remote|https://x/aviso.mp3', inboundRoutes: { '910000000': '201' }, defaultExtension: null, outboundCallerId: null, recordAudio: 'mono', recordNoconnect: false, ringSeconds: 30, maxCallSeconds: 3600 };
  const call = { ID: '1791201600.9', src: '600111222', dst: '910000000' };

  it('entrante: aviso → grabación → conexión, y evento al contestar', () => {
    const state: CallState = {};
    expect(nextCommand(call, state, cfg).response).toMatchObject({ command: 'speak', userfield: 'aviso' });
    expect(nextCommand({ ...call, command: 'speak', userfield: 'aviso', statuscode: '200' }, state, cfg).response).toMatchObject({ command: 'record' });
    const dial = nextCommand({ ...call, command: 'record', userfield: 'record', description: '/APIVoice/Record/x.mp3', URLDownload: 'https://d' }, state, cfg);
    expect(dial.response).toMatchObject({ command: 'dial', options: 'extension,201,30,calling,3600,', userfield: 'dial' });
    const end = nextCommand({ ...call, command: 'dial', userfield: 'dial', description: 'ANSWER', durationcallanswered: '42' }, state, cfg);
    expect(end.response.command).toBe('hangup');
    expect(end.event).toMatchObject({ uniqueid: '1791201600.9', file: '/APIVoice/Record/x.mp3', duration: 42, url_download: 'https://d' });
  });

  it('si el aviso falla conecta sin grabar y no genera evento', () => {
    const state: CallState = {};
    nextCommand(call, state, cfg);
    const dial = nextCommand({ ...call, command: 'speak', userfield: 'aviso', statuscode: '500' }, state, cfg);
    expect(dial.response.userfield).toBe('dial_norec');
    expect(nextCommand({ ...call, command: 'dial', userfield: 'dial_norec', description: 'ANSWER' }, state, cfg).event).toBeNull();
  });

  it('cuelga si el llamante se va durante el aviso o no hay ruta', () => {
    expect(nextCommand({ ...call, command: 'speak', userfield: 'aviso', statuscall: 'CANCEL' }, {}, cfg).response.command).toBe('hangup');
    expect(nextCommand({ ...call, dst: '919999999' }, {}, cfg).response).toMatchObject({ command: 'hangup', userfield: 'no_route' });
  });

  it('saliente: graba y el aviso suena al destino antes de conectar; sin locución no graba', () => {
    const out = { ID: 'o1', src: '113', dst: '600111222' };
    const state: CallState = {};
    expect(nextCommand(out, state, cfg).response.command).toBe('record');
    expect(nextCommand({ ...out, command: 'record', description: '/r.mp3' }, state, cfg).response.options).toBe('pstn,600111222,30,calling,3600,remote|https://x/aviso.mp3');
    expect(nextCommand(out, {}, { ...cfg, avisoAnnounce: null }).response.userfield).toBe('dial_norec');
  });

  it('saliente real: tras colgar llegan los avisos de grabación y solo la conversación genera evento', () => {
    const out = { ID: '1792090207.506672', src: '113', dst: '00573000000000' };
    const state: CallState = {};
    nextCommand(out, state, cfg);
    nextCommand({ ...out, command: 'record', userfield: 'record', statuscode: '200', description: 'OK' }, state, cfg);
    expect(nextCommand({ ...out, command: 'dial', userfield: 'dial', description: 'ANSWER', durationcallanswered: '27' }, state, cfg).event).toBeNull();
    const notice = { ...out, api: 'x', status: 'OK', URLAudio: 'https://a', URLDownload: 'https://d' };
    expect(nextCommand({ ...notice, description: '/APIVoice/Record/2026-10-15/x_announce.mp3' }, state, cfg).event).toBeNull();
    const result = nextCommand({ ...notice, description: '/APIVoice/Record/2026-10-15/x.mp3' }, state, cfg);
    expect(result.response.command).toBe('hangup');
    expect(result.event).toMatchObject({ uniqueid: '1792090207.506672', file: '/APIVoice/Record/2026-10-15/x.mp3', duration: 27, userexten: '113', url_download: 'https://d' });
  });

  it('en estéreo la grabación es el fichero _announce (el único que genera Netelip)', () => {
    const stereo = { ...cfg, recordAudio: 'stereo' as const };
    const out = { ID: 'st1', src: '113', dst: '00573000000000' };
    const state: CallState = {};
    nextCommand(out, state, stereo);
    nextCommand({ ...out, command: 'record', userfield: 'record', description: 'OK' }, state, stereo);
    nextCommand({ ...out, command: 'dial', userfield: 'dial', description: 'ANSWER', durationcallanswered: '60' }, state, stereo);
    const result = nextCommand({ ...out, description: '/APIVoice/Record/x_announce.mp3', URLDownload: 'https://d' }, state, stereo);
    expect(result.event).toMatchObject({ file: '/APIVoice/Record/x_announce.mp3', duration: 60 });
  });

  it('cuenta como contestada si cuelga quien llama (CANCEL con segundos de conversación)', () => {
    const out = { ID: 'c1', src: '113', dst: '00573000000000' };
    const state: CallState = {};
    nextCommand(out, state, cfg);
    nextCommand({ ...out, command: 'record', userfield: 'record', description: 'OK' }, state, cfg);
    nextCommand({ ...out, command: 'dial', userfield: 'dial', statuscall: 'CANCEL', durationcallanswered: '48' }, state, cfg);
    expect(nextCommand({ ...out, description: '/APIVoice/Record/x.mp3', URLDownload: 'https://d' }, state, cfg).event).toMatchObject({ duration: 48 });
    const missed: CallState = {};
    nextCommand(out, missed, cfg);
    nextCommand({ ...out, command: 'record', userfield: 'record', description: 'OK' }, missed, cfg);
    nextCommand({ ...out, command: 'dial', userfield: 'dial', statuscall: 'CANCEL', durationcallanswered: '0' }, missed, cfg);
    expect(nextCommand({ ...out, description: '/APIVoice/Record/x.mp3', URLDownload: 'https://d' }, missed, cfg).event).toBeNull();
  });

  it('sin contestar o sin grabación, el aviso de fichero no genera evento', () => {
    const out = { ID: 'o3', src: '113', dst: '00573000000000' };
    const state: CallState = {};
    nextCommand(out, state, cfg);
    nextCommand({ ...out, command: 'record', userfield: 'record', description: 'OK' }, state, cfg);
    nextCommand({ ...out, command: 'dial', userfield: 'dial', description: 'BUSY' }, state, cfg);
    expect(nextCommand({ ...out, description: '/APIVoice/Record/x.mp3', URLDownload: 'https://d' }, state, cfg).event).toBeNull();
  });

  it('graba en estéreo si está configurado', () => {
    expect(nextCommand({ ID: 's1', src: '113', dst: '600111222' }, {}, { ...cfg, recordAudio: 'stereo' }).response).toEqual({ command: 'record', options: ',stereo', userfield: 'record' });
    expect(nextCommand({ ID: 's2', src: '113', dst: '600111222' }, {}, { ...cfg, recordAudio: 'stereo', recordNoconnect: true }).response.options).toBe('noconnect,stereo');
  });

  it('saliente con identificador: callerid antes de grabar y marcar', () => {
    const out = { ID: 'o2', src: '113', dst: '00573000000000' };
    const withCid = { ...cfg, outboundCallerId: 'Grupo LYN;34910000000' };
    const state: CallState = {};
    expect(nextCommand(out, state, withCid).response).toEqual({ command: 'callerid', options: 'Grupo LYN;34910000000', userfield: 'callerid' });
    expect(nextCommand({ ...out, command: 'callerid', userfield: 'callerid', statuscode: '200' }, state, withCid).response.command).toBe('record');
    expect(nextCommand({ ...out, command: 'record', userfield: 'record', description: 'OK' }, state, withCid).response).toMatchObject({ command: 'dial', userfield: 'dial' });
  });
});

describe('Netelip · vinculación por teléfono', () => {
  const index: DirectoryIndex = new Map([
    ['+34600000001', { clients: new Set(['c1']), leads: new Map() }],
    ['+34600000002', { clients: new Set(), leads: new Map([['l1', null]]) }],
    ['+34600000003', { clients: new Set(['c2']), leads: new Map([['l2', null]]) }],
    ['+34600000004', { clients: new Set(['c3']), leads: new Map([['l3', 'c3']]) }],
  ]);
  it('distingue cliente, lead, desconocido, oculto, múltiple y lead ya convertido', () => {
    expect(matchPhone(index, '+34600000001')).toEqual({ status: 'matched', client_id: 'c1', lead_id: null });
    expect(matchPhone(index, '+34600000002')).toEqual({ status: 'matched', client_id: null, lead_id: 'l1' });
    expect(matchPhone(index, '+34699999999').status).toBe('unknown');
    expect(matchPhone(index, null).status).toBe('hidden');
    expect(matchPhone(index, '+34600000003').status).toBe('multiple');
    expect(matchPhone(index, '+34600000004')).toEqual({ status: 'matched', client_id: 'c3', lead_id: null });
  });
});

describe('Netelip · permisos y WhatsApp', () => {
  it('solo Director, superadmin y admin ven el historial de llamadas', () => {
    for (const role of ['superadmin', 'admin', 'employee:director', 'employee:director_general', 'Employee:Director General']) expect(canAccessNetelipCalls(role, {})).toBe(true);
    for (const role of ['ceo', 'employee:direccion_de_operaciones', 'employee:director_de_operaciones', 'employee:pmc_proyectos', 'consulta_publica', '']) expect(canAccessNetelipCalls(role, {})).toBe(false);
  });

  it('P6: por defecto leen el texto los mismos roles, y nunca alguien sin acceso a la sección', () => {
    expect(canReadTranscripts('employee:director', {})).toBe(true);
    expect(canReadTranscripts('admin', {})).toBe(true);
    expect(canReadTranscripts('employee:direccion_de_operaciones', {})).toBe(false);
    expect(canReadTranscripts('admin', { NETELIP_TRANSCRIPT_READER_ROLES: 'superadmin' })).toBe(false);
    expect(canReadTranscripts('ceo', { NETELIP_TRANSCRIPT_READER_ROLES: 'ceo' })).toBe(false);
  });

  it('valida el evento de llamada de WhatsApp', () => {
    const event = parseWhatsAppCall({ wacid: 'wacid.X', direction: 'inbound', customer_phone: '+34600111222', started_at: 1791848171, duration: 95, status: 'answered', aviso: 'played', recording: '/r.wav' });
    expect(event).toMatchObject({ status: 'ANSWERED', aviso: 'played', customer_wa_user_id: null });
    expect(() => parseWhatsAppCall({ wacid: 'w', direction: 'sideways', customer_phone: '1', started_at: 1 })).toThrow(/direction/);
    expect(() => parseWhatsAppCall({ wacid: 'w', direction: 'inbound', started_at: 1 })).toThrow(/customer_phone/);
  });
});
