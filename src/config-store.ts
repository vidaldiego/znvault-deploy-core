// Path: src/config-store.ts
// Deployment configuration storage — target-agnostic, per-plugin config location.
//
// The original (`znvault-plugin-payara/src/cli/config-store.ts`) hardcoded
// payara's config dir via PAYARA_CONFIG_DIR/CONFIG_FILE/LEGACY_CONFIG_FILE.
// Config file location is a per-deployer-plugin concern (see constants.ts),
// so every exported function here takes a `ConfigStoreLocation` as its first
// argument instead of reading module-level constants.

import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { DeployConfig } from './types.js';

/**
 * Where a plugin's deploy configs live on disk.
 *
 * - `configDir` / `configFile`: the per-plugin config directory and the
 *   JSON file within it (e.g. `~/.znvault/payara/configs.json`).
 * - `legacyConfigFile`: optional pre-v2 shared flat-file location to
 *   auto-migrate from on first load. Only payara (which predates the
 *   per-plugin split) has one; a greenfield plugin like archon omits it,
 *   which disables the migration step entirely.
 */
export interface ConfigStoreLocation {
  configFile: string;
  legacyConfigFile?: string;
  configDir: string;
}

/**
 * One-time, non-destructive migration from a legacy shared config location
 * to the per-deployer file. Runs only when `loc.legacyConfigFile` is
 * provided, the new file is absent, and the legacy file exists. The legacy
 * file is left intact as a backup. Never throws — a migration failure must
 * not make an existing config unusable.
 */
async function migrateLegacyConfigIfNeeded(loc: ConfigStoreLocation): Promise<void> {
  if (!loc.legacyConfigFile) return;
  if (existsSync(loc.configFile) || !existsSync(loc.legacyConfigFile)) return;
  try {
    await mkdir(loc.configDir, { recursive: true });
    await copyFile(loc.legacyConfigFile, loc.configFile);
    // Notice to stderr, not stdout — keep machine-readable output clean.
    console.error(`Migrated deploy configs to ${loc.configFile} (legacy ${loc.legacyConfigFile} kept as backup).`);
  } catch (err) {
    console.error(`Warning: could not migrate legacy config (${(err as Error).message}); using legacy location.`);
  }
}

/**
 * Load deployment configs from file. Reads the new path; on first run
 * (when `loc.legacyConfigFile` is set) migrates the legacy file into
 * place. Falls back to the legacy file if migration failed.
 */
export async function loadDeployConfigs(loc: ConfigStoreLocation): Promise<Record<string, DeployConfig>> {
  await migrateLegacyConfigIfNeeded(loc);
  // Prefer the new path; if migration failed/was skipped and it's still
  // absent, fall back to the legacy file (when one is configured).
  const source = existsSync(loc.configFile) ? loc.configFile : loc.legacyConfigFile;
  try {
    if (source && existsSync(source)) {
      const content = await readFile(source, 'utf-8');
      return JSON.parse(content);
    }
  } catch {
    // Ignore parse errors
  }
  return {};
}

/**
 * Save deployment configs to the per-plugin config path.
 */
export async function saveDeployConfigs(loc: ConfigStoreLocation, configs: Record<string, DeployConfig>): Promise<void> {
  if (!existsSync(loc.configDir)) {
    await mkdir(loc.configDir, { recursive: true });
  }
  await writeFile(loc.configFile, JSON.stringify(configs, null, 2));
}

/**
 * Get a config by name, or undefined if not found.
 */
export async function getConfig(loc: ConfigStoreLocation, name: string): Promise<DeployConfig | undefined> {
  const configs = await loadDeployConfigs(loc);
  return configs[name];
}

/**
 * Check if a config exists.
 */
export async function configExists(loc: ConfigStoreLocation, name: string): Promise<boolean> {
  const configs = await loadDeployConfigs(loc);
  return name in configs;
}

/**
 * List all config names.
 */
export async function listConfigNames(loc: ConfigStoreLocation): Promise<string[]> {
  const configs = await loadDeployConfigs(loc);
  return Object.keys(configs);
}
