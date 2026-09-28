import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

const source = await readFile(new URL('../../deploy/scripts/deploy.sh', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../../.github/workflows/quality.yml', import.meta.url), 'utf8');

test('publica assets antes de sustituir index.html de manera atómica', () => {
  const assets = source.indexOf('rsync -a --chown=lyn:lyn "$ROOT/frontend/dist/assets/"');
  const publish = source.indexOf('mv -f /var/www/lyn/dashboard/.index.html.next');
  assert.ok(assets > source.indexOf('systemctl restart lyn-evolution lyn-backend'));
  assert.ok(publish > assets);
  assert.match(source, /--exclude='index.html'/);
  assert.doesNotMatch(source, /rsync[^\n]*--delete[^\n]*dist\/assets/);
});

test('CI habilita las integraciones PostgreSQL en una base aislada', () => {
  assert.match(workflow, /QA_TEST_DATABASE_URL: postgresql:\/\/postgres:postgres@127\.0\.0\.1:5432\/lyn_qa_retest/);
  assert.match(workflow, /CREATE DATABASE lyn_qa_retest/);
});

test('no publica HTML antes de comprobar readiness ni elimina assets de sesiones abiertas', () => {
  assert.ok(source.indexOf('wait_for_backend /etc/lyn/backend.env') < source.indexOf('mv -f /var/www/lyn/dashboard/.index.html.next'));
  assert.ok(source.indexOf('npm prune --omit=dev') < source.indexOf('systemctl restart lyn-evolution lyn-backend'));
  assert.doesNotMatch(source, /assets.*-delete/);
  assert.match(source, /wait_for_backend "\$instance_dir\/backend.env"/);
});

test('readiness reintenta, falla cerrado y rechaza puertos inválidos', () => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  const cases = [
    ['curl() { return 0; }; wait_for_backend <(printf "PORT=3003\\n")', 0],
    ['curl() { return 1; }; sleep() { :; }; wait_for_backend <(printf "PORT=3003\\n")', 1],
    ['curl() { exit 99; }; wait_for_backend <(printf "PORT=invalid\\n")', 1],
    ['attempts=0; curl() { attempts=$((attempts+1)); [[ $attempts -gt 2 ]]; }; sleep() { :; }; wait_for_backend <(printf "PORT=3003\\n"); [[ $attempts -eq 3 ]]', 0],
  ];
  for (const [command, expected] of cases) {
    const result = spawnSync(bash, ['-c', `source deploy/scripts/readiness.sh; ${command}`], { encoding: 'utf8' });
    assert.equal(result.status, expected, result.stderr);
  }
});
