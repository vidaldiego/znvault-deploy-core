import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function releaseChannel(version: string): string {
  const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  const match = workflow.match(/id: release-channel[\s\S]*?run: \|\n([\s\S]*?)\n {6}- name:/);
  if (!match) throw new Error('Release-channel workflow step missing');
  const script = match[1].replace(/^ {10}/gm, '');
  const root = mkdtempSync(join(tmpdir(), 'core-release-channel-'));
  roots.push(root);
  const output = join(root, 'output');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
  execFileSync('bash', ['-c', script], { cwd: root, env: { ...process.env, GITHUB_OUTPUT: output } });
  return readFileSync(output, 'utf8');
}

describe('published deployment dependency channels', () => {
  it('publishes the sandbox-compatible core without advancing fleet latest', () => {
    expect(releaseChannel('0.3.0')).toBe('dist_tag=dr-m4\nmake_latest=false\n');
  });
  it('keeps the existing migration core on its isolated channel', () => {
    expect(releaseChannel('0.2.4')).toBe('dist_tag=dr-m4\nmake_latest=false\n');
  });
  it('preserves the legacy production-compatible channel', () => {
    expect(releaseChannel('0.1.2')).toBe('dist_tag=latest\nmake_latest=true\n');
  });
  it('keeps legacy prereleases off latest', () => {
    expect(releaseChannel('0.1.3-rc.1')).toBe('dist_tag=next\nmake_latest=false\n');
  });
});
