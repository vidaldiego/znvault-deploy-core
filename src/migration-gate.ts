// Path: src/migration-gate.ts
// Engine-agnostic PRE/POST migration-phase gating, lifted from
// znvault-plugin-payara's deploy-run.ts (siblingIntegrityDirs +
// runMigrationPhase). The gating logic (skip-reason lines, dry-run,
// scoped-subset guards) is target-agnostic; the actual "run one migration
// phase" call is engine-specific (payara: mysql via @zincapp/znvault-migrate;
// archon: Prisma), so it is injected via `runPhase` rather than hardcoded
// here. The dry-run display line is similarly injected via `dryRunRender`
// since its wording references engine-specific config shape.

import type { CLIPluginContext, DeployConfig, MigrationConfig } from './types.js';
import type { MigrationSkipReason } from './post-gate.js';

/**
 * A plugin supplies how to actually run one migration phase.
 */
export type RunPhaseFn = (
  migration: MigrationConfig,
  phase: 'pre-deploy' | 'post-deploy',
  ctx: CLIPluginContext,
) => Promise<void>;

/**
 * A plugin supplies how to render its config in a dry-run line.
 */
export type DryRunRenderFn = (migration: MigrationConfig, phase: string) => string;

/**
 * The OTHER migration phase's directory (post's dir for the pre phase, and vice
 * versa), as a one-element array for `integrityDirs` — or `[]` when the other phase
 * is unconfigured or shares this phase's directory. Both phases write to the same
 * schema_migrations table, so the planner's integrity check must know about the
 * sibling dir to avoid flagging its rows as orphaned. Pure (zero I/O).
 */
export function siblingIntegrityDirs(
  config: DeployConfig,
  phase: 'pre-deploy' | 'post-deploy',
): string[] {
  const own = phase === 'pre-deploy' ? config.migration?.migrationsDir : config.postMigration?.migrationsDir;
  const other = phase === 'pre-deploy' ? config.postMigration?.migrationsDir : config.migration?.migrationsDir;
  if (!other || other === own) return [];
  return [other];
}

/**
 * Run a schema-migration phase (pre-deploy or post-deploy) if a migration config
 * is provided. No-op when `migration` is undefined.
 *
 * @param migration    - The migration config for this phase (undefined = no-op).
 * @param phase        - Which phase this is, for log lines and skip-reason messages.
 * @param configName   - The config name, used in the recovery hint message.
 * @param ctx          - The CLI plugin context (output + client).
 * @param runPhase     - Plugin-supplied callback that actually runs the phase
 *                       (engine-specific: mysql for payara, Prisma for archon).
 * @param dryRunRender - Plugin-supplied callback that renders the dry-run plan line.
 * @param opts         - `dryRun` prints the plan only; `run: false` skips with a
 *                       reason-tagged log line built from `skipReason`.
 */
export async function runMigrationPhase(
  migration: MigrationConfig | undefined,
  phase: 'pre-deploy' | 'post-deploy',
  configName: string,
  ctx: CLIPluginContext,
  runPhase: RunPhaseFn,
  dryRunRender: DryRunRenderFn,
  opts: {
    dryRun?: boolean;
    run?: boolean;
    skipReason?: MigrationSkipReason;
    integrityDirs?: string[];
    /**
     * Plugin-specific wording for the skip-reason messages so the shared gate
     * stays target-agnostic. Defaults preserve payara's exact original text
     * (byte-identical for payara, which omits these). Archon (Plan 4) passes
     * `artifact: 'build'` and a `postOnlyRecoveryHint` naming `archon deploy`.
     */
    labels?: { artifact?: string; postOnlyRecoveryHint?: string };
  } = {},
): Promise<void> {
  if (!migration) return;

  const artifact = opts.labels?.artifact ?? 'WAR';
  const postOnlyRecoveryHint =
    opts.labels?.postOnlyRecoveryHint ?? `payara deploy run ${configName} --post-only`;

  // Skip (with a reason-tagged line so incident logs are accurate).
  if (opts.run === false) {
    const r = opts.skipReason;
    let msg: string;
    if (!r || r.kind === 'flag') {
      const flag = r && r.kind === 'flag' ? r.flag : 'flag';
      msg = `[deploy] Skipping ${phase} schema migrations (${flag}).`;
    } else if (r.kind === 'scoped-subset') {
      msg = `[deploy] Skipping ${phase} schema migrations: deploy scoped to a subset (other hosts still run the previous ${artifact}). Run a full deploy or '${postOnlyRecoveryHint}' once all hosts are current.`;
    } else if (r.kind === 'partial-coverage') {
      msg = `[deploy] Skipping ${phase} schema migrations: ${r.dropped.length} configured host(s) were not deployed (${r.dropped.join(', ')}) — they still run the previous ${artifact}.`;
    } else {
      msg = `[deploy] Skipping ${phase} schema migrations: rollout did not fully succeed.`;
    }
    ctx.output.info(msg);
    return;
  }

  // --dry-run: print the plan only, no side effects.
  if (opts.dryRun) {
    ctx.output.info(dryRunRender(migration, phase));
    return;
  }

  ctx.output.info(`[deploy] Running ${phase} schema migrations...`);
  await runPhase(migration, phase, ctx);
  ctx.output.info(`[deploy] ${phase} migrations complete.`);
}
