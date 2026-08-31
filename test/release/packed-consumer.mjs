import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workDir = mkdtempSync(join(tmpdir(), 'znvault-deploy-core-packed-'));

try {
  execFileSync('npm', ['run', 'build:prod'], { cwd: repoRoot, stdio: 'inherit' });
  const packOutput = execFileSync(
    'npm',
    ['pack', '--json', '--pack-destination', workDir],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const [{ filename }] = JSON.parse(packOutput);
  const tarball = join(workDir, filename);
  const consumerDir = join(workDir, 'consumer');
  mkdirSync(consumerDir);
  writeFileSync(join(consumerDir, 'package.json'), '{"private":true,"type":"module"}\n');
  execFileSync(
    'npm',
    ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', tarball],
    { cwd: consumerDir, stdio: 'inherit' },
  );
  execFileSync('npm', ['ls', 'undici', '--omit=dev'], {
    cwd: consumerDir,
    stdio: 'inherit',
  });

  const probePath = join(consumerDir, 'probe.mjs');
  writeFileSync(probePath, `
import { agentGet, configureTLS } from '@zincapp/znvault-deploy-core';

let captured;
globalThis.fetch = async (_url, init) => {
  captured = init;
  return { ok: true, json: async () => ({ healthy: true }) };
};
configureTLS({ verify: true, caCert: 'packed-consumer-test-ca' });
await agentGet(
  'https://agent.example/status',
  1000,
  { bearerToken: 'a'.repeat(43) },
);
if (!captured?.dispatcher) throw new Error('Packed consumer has no Undici dispatcher');
if (captured.redirect !== 'error') throw new Error('Authenticated redirect policy is not fail-closed');
`);
  execFileSync(process.execPath, [probePath], { cwd: consumerDir, stdio: 'inherit' });
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
