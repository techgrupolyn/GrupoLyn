import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createClubSsoRouter, ssoOrigin } from '../club-sso.ts';

const club = 'http://localhost:8080';
const dashboard = 'http://localhost:5173';
const verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const identity = { id: 'supabase-user', email: 'employee@example.test', name: 'Empleado' };
const user = { id: 12, usuario: 'sb_user', nombre: 'Empleado', rol: 'employee:pmc' };

function setup(origins = { clubOrigin: club, dashboardOrigin: dashboard }) {
  let time = 0;
  const authenticate = vi.fn(async () => identity as typeof identity | null);
  const resolveUser = vi.fn(async () => user as typeof user | null);
  const app = express();
  app.use(express.json());
  app.use('/api/auth/club-sso', createClubSsoRouter({ ...origins, authenticate, resolveUser, createToken: () => 'dashboard-token', now: () => time }));
  const client = request(app);
  const issue = () => client.post('/api/auth/club-sso/handoff').set('Origin', club).set('Authorization', 'Bearer remote-token').send({ challenge });
  const exchange = (code: string, proof = verifier) => client.post('/api/auth/club-sso/exchange').set('Origin', dashboard).send({ code, verifier: proof });
  return { client, authenticate, resolveUser, issue, exchange, advance: () => { time += 60001; } };
}

describe('Club LYN SSO', () => {
  it('validates the remote session and exchanges a code once without returning remote credentials', async () => {
    const test = setup();
    const grant = await test.issue();
    expect(grant.status).toBe(200);
    expect(grant.headers['cache-control']).toBe('no-store');
    expect(test.authenticate).toHaveBeenCalledWith('remote-token');
    expect(JSON.stringify(grant.body)).not.toContain('remote-token');
    const result = await test.exchange(grant.body.code);
    expect(result.body).toEqual({ usuario: user, token: 'dashboard-token' });
    expect(test.resolveUser).toHaveBeenCalledTimes(2);
    expect((await test.exchange(grant.body.code)).status).toBe(401);
  });
  it('rejects an expired or invalid Supabase session', async () => {
    const test = setup(); test.authenticate.mockResolvedValue(null);
    expect((await test.issue()).status).toBe(401);
    expect(test.resolveUser).not.toHaveBeenCalled();
  });
  it('rejects valid identities without meeting access', async () => {
    const test = setup(); test.resolveUser.mockResolvedValue(null);
    expect((await test.issue()).status).toBe(403);
  });
  it('checks revocation again at exchange', async () => {
    const test = setup(); const grant = await test.issue();
    test.resolveUser.mockResolvedValue(null);
    expect((await test.exchange(grant.body.code)).status).toBe(403);
  });
  it('rejects stolen codes without the browser proof', async () => {
    const test = setup(); const grant = await test.issue();
    expect((await test.exchange(grant.body.code, 'x'.repeat(43))).status).toBe(401);
    expect((await test.exchange(grant.body.code)).status).toBe(200);
  });
  it('rejects expired codes', async () => {
    const test = setup(); const grant = await test.issue(); test.advance();
    expect((await test.exchange(grant.body.code)).status).toBe(401);
  });
  it('only one concurrent exchange can succeed', async () => {
    const test = setup(); const grant = await test.issue();
    const results = await Promise.all([test.exchange(grant.body.code), test.exchange(grant.body.code)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
  });
  it('refuses missing and hostile origins without authenticating', async () => {
    const test = setup();
    for (const origin of ['', 'https://evil.example', `${club}.evil.example`]) {
      const result = await test.client.post('/api/auth/club-sso/handoff').set('Origin', origin).set('Authorization', 'Bearer remote').send({ challenge });
      expect(result.status).toBe(403);
    }
    expect(test.authenticate).not.toHaveBeenCalled();
  });
  it('requires the dashboard origin to exchange codes', async () => {
    const test = setup(); const grant = await test.issue();
    const result = await test.client.post('/api/auth/club-sso/exchange').set('Origin', club).send({ code: grant.body.code, verifier });
    expect(result.status).toBe(403);
  });
  it('uses server roles, ignoring supplied email and administrator claims', async () => {
    const test = setup();
    const grant = await test.client.post('/api/auth/club-sso/handoff').set('Origin', club).set('Authorization', 'Bearer remote').send({ challenge, rol: 'superadmin', email: 'boss@example.test' });
    const result = await test.exchange(grant.body.code);
    expect(result.body.usuario.rol).toBe('employee:pmc');
    expect(test.resolveUser).toHaveBeenCalledWith(identity);
  });
  it('allows only explicit origins in the CORS preflight', async () => {
    const test = setup();
    for (const origin of [club, 'https://evil.example']) {
      const response = await test.client.options('/api/auth/club-sso/handoff').set('Origin', origin).set('Access-Control-Request-Method', 'POST');
      expect(response.headers['access-control-allow-origin']).toBe(origin === club ? club : undefined);
    }
  });
  it('fails closed without configuration and hides internal errors', async () => {
    const disabled = setup({ clubOrigin: '', dashboardOrigin: dashboard });
    expect((await disabled.issue()).status).toBe(503);
    const test = setup(); test.authenticate.mockRejectedValue(new Error('SECRET server details'));
    const response = await test.issue();
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toContain('SECRET');
  });
  it('validates origins without allowing insecure remote hosts, credentials or paths', () => {
    for (const value of ['*', 'http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?next=evil']) expect(ssoOrigin(value)).toBe('');
    expect(ssoOrigin('https://club.example')).toBe('https://club.example');
  });
});
