import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

const source = await readFile(new URL('../../deploy/scripts/deploy.sh', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../../.github/workflows/quality.yml', import.meta.url), 'utf8');
const historyDeploy = await readFile(new URL('../../deploy/scripts/deploy-global-summary.sh', import.meta.url), 'utf8');
const historyResume = await readFile(new URL('../../deploy/scripts/resume-phone-history-2490cca.sh', import.meta.url), 'utf8');

test('reanudación OOM fija versión y respaldo, empaqueta antes de detener y no restaura datos', () => {
  assert.match(historyResume, /expected=2490ccac84936e1d86e99f639e90edb596a11079/);
  assert.match(historyResume, /gitlyn diff --quiet HEAD -- backend evolution-api deploy/);
  assert.match(historyResume, /sha256sum -c SHA256SUMS/);
  assert.match(historyResume, /test ! -e "\$backup\/evolution-dist-before"/);
  assert.match(historyResume, /node --max-old-space-size=256 node_modules\/tsup\/dist\/cli-default.js/);
  assert.doesNotMatch(historyResume, /typescript\/bin\/tsc|npm ci|npm install|pg_restore|reset --hard|rm -rf/);
  assert.ok(historyResume.indexOf('node --check "$stage/main.js"') < historyResume.indexOf('systemctl stop lyn-evolution'));
  assert.ok(historyResume.indexOf('[[ "$ready" == true ]]') < historyResume.indexOf('systemctl restart lyn-backend'));
});

test('recuperación telefónica compila en staging y respalda Evolution antes de detener servicios', () => {
  assert.match(historyDeploy, /mode=\$\{2:-backend\}/);
  assert.match(historyDeploy, /evolution-api\/package\.json evolution-api\/package-lock\.json evolution-api\/prisma frontend/);
  const backup = historyDeploy.indexOf('"$backup/evolution-dist.tar.gz"');
  const build = historyDeploy.indexOf('env LYN_EVOLUTION_BUILD_DIR="$stage"');
  const stop = historyDeploy.indexOf('systemctl stop lyn-backend lyn-evolution');
  assert.ok(backup > 0 && build > backup && stop > build);
  assert.ok(historyDeploy.indexOf('node --check "$stage/main.js"') < stop);
  assert.match(historyDeploy, /mv "\$ROOT\/evolution-api\/dist" "\$backup\/evolution-dist-before"/);
  assert.doesNotMatch(historyDeploy, /npm ci|npm install|reset --hard|rm -rf/);
});

test('publica assets antes de sustituir index.html de manera atómica', () => {
  const assets = source.indexOf('rsync -a --chown=lyn:lyn "$ROOT/frontend/dist/assets/"');
  const publish = source.indexOf('mv -f /var/www/lyn/dashboard/.index.html.next');
  assert.ok(assets > source.indexOf('systemctl restart lyn-evolution lyn-backend'));
  assert.ok(publish > assets);
  assert.match(source, /--exclude='index.html'/);
  assert.doesNotMatch(source, /rsync[^\n]*--delete[^\n]*dist\/assets/);
});

test('dependencias backend se preparan antes de detener y se conservan las anteriores', () => {
  assert.match(historyDeploy, /mode.*backend-deps/);
  assert.match(historyDeploy, /gitlyn diff --quiet "\$before" "\$expected" -- backend\/package.json evolution-api frontend/);
  const install = historyDeploy.indexOf('npm --prefix "$dependency_stage" ci --omit=dev --no-audit --no-fund');
  const stop = historyDeploy.indexOf('systemctl stop lyn-backend\n');
  assert.ok(install > historyDeploy.indexOf('sha256sum -c SHA256SUMS'));
  assert.ok(stop > install);
  assert.ok(historyDeploy.indexOf('test -f "$dependency_stage/node_modules/tsx/dist/cli.mjs"') < stop);
  assert.match(historyDeploy, /mv "\$ROOT\/backend\/node_modules" "\$backup\/backend-node_modules-before"/);
  assert.match(historyDeploy, /mv "\$backup\/backend-node_modules-before" "\$ROOT\/backend\/node_modules"/);
  assert.doesNotMatch(historyDeploy, /npm (audit fix|update)|--force|rm -rf/);
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
