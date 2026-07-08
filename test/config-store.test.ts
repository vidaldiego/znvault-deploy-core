// Path: test/config-store.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDeployConfigs, loadDeployConfigs } from '../src/config-store.js';

describe('config-store per-plugin location', () => {
  it('writes/reads under the injected configDir, isolated per plugin', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cfgstore-'));
    const payara = { configDir: join(base, 'payara'), configFile: join(base, 'payara', 'configs.json') };
    const archon = { configDir: join(base, 'archon'), configFile: join(base, 'archon', 'configs.json') };
    await saveDeployConfigs(payara, { staging: { name: 'staging' } as any });
    await saveDeployConfigs(archon, { production: { name: 'production' } as any });
    expect(Object.keys(await loadDeployConfigs(payara))).toEqual(['staging']);
    expect(Object.keys(await loadDeployConfigs(archon))).toEqual(['production']);
    await rm(base, { recursive: true, force: true });
  });
});
