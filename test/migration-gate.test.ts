// Path: test/migration-gate.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runMigrationPhase } from '../src/migration-gate.js';

const ctx = () => ({ output: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }) as any;

describe('runMigrationPhase gating (engine-agnostic)', () => {
  it('no-op when migration config is undefined', async () => {
    const runPhase = vi.fn();
    await runMigrationPhase(undefined, 'pre-deploy', 'cfg', ctx(), runPhase, () => '');
    expect(runPhase).not.toHaveBeenCalled();
  });

  it('skips with a reason line when opts.run === false and calls runPhase never', async () => {
    const c = ctx(); const runPhase = vi.fn();
    await runMigrationPhase({ roleId: 'r' } as any, 'post-deploy', 'cfg', c, runPhase, () => '',
      { run: false, skipReason: { kind: 'scoped-subset' } });
    expect(runPhase).not.toHaveBeenCalled();
    expect(c.output.info).toHaveBeenCalledWith(expect.stringContaining('scoped to a subset'));
  });

  it('dry-run prints the plugin-supplied render, no runPhase', async () => {
    const c = ctx(); const runPhase = vi.fn();
    await runMigrationPhase({ roleId: 'r' } as any, 'pre-deploy', 'cfg', c, runPhase,
      (m, p) => `RENDER ${p} ${m.roleId}`, { dryRun: true });
    expect(runPhase).not.toHaveBeenCalled();
    expect(c.output.info).toHaveBeenCalledWith(expect.stringContaining('RENDER pre-deploy r'));
  });

  it('invokes runPhase when run !== false and not dry-run', async () => {
    const runPhase = vi.fn().mockResolvedValue(undefined);
    await runMigrationPhase({ roleId: 'r' } as any, 'pre-deploy', 'cfg', ctx(), runPhase, () => '', {});
    expect(runPhase).toHaveBeenCalledOnce();
  });
});
