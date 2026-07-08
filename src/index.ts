// Path: src/index.ts
// Public entry point for @zincapp/znvault-deploy-core.
//
// Target-agnostic deploy machinery (multi-class rollout, canary strategy
// execution, HAProxy drain/ready, SSH-CA tunnel, host checks, post-deploy
// gating, config resolution/validation, formatters, unified progress
// display, and the agent HTTP client) shared across znvault deployer
// plugins (e.g. znvault-plugin-payara).

// --- Shared types --------------------------------------------------------
export type {
  CLIPluginContext,
  CLIPlugin,
  DeploymentStrategyBatch,
  DeploymentStrategy,
  HealthCheckConfig,
  HealthCheckResult,
  DeployTLSConfig,
  HAProxyConfig,
  DeploySshConfig,
  QuiesceConfig,
  SharedDeployDefaults,
  DeployClass,
  DeployConfig,
  MigrationConfig,
  DeployConfigStore,
  DeploymentStatusResponse,
  AgentPostResult,
  HostReachableResult,
  PreflightResult,
  DeployContext,
  StrategyProgressReporter,
  PluginVersionInfo,
  PluginVersionsResponse,
  PluginUpdateResult,
  PluginUpdateResponse,
  PluginVersionCheckResult,
  TriggerUpdateResult,
  DeployToHostResult,
  DeployOperationResult,
  DeployResult,
} from './types.js';
export { parseDeploymentStrategy, getStrategyDisplayName } from './types.js';

// --- strategy-executor -----------------------------------------------------
export {
  executeStrategy,
  resolveStrategy,
} from './strategy-executor.js';
export type {
  StrategyExecutionResult,
  StrategyExecutorOptions,
} from './strategy-executor.js';

// --- multi-class-deploy ------------------------------------------------
export {
  executeMultiClassDeployment,
  classGateFailed,
  printMultiClassDryRun,
  printMultiClassSummary,
} from './multi-class-deploy.js';
export type {
  ClassOutcome,
  RunClassResult,
  MultiClassResult,
} from './multi-class-deploy.js';

// --- haproxy ---------------------------------------------------------------
export {
  drainServer,
  readyServer,
  setServerState,
  testHAProxyConnectivity,
  getUnmappedHosts,
  sshExec,
} from './haproxy.js';
export type {
  SSHExecResult,
  HAProxyOperationResult,
} from './haproxy.js';

// --- ssh-tunnel --------------------------------------------------------
export {
  openTunnel,
  isLoopbackHost,
  resolveZnvaultBin,
} from './ssh-tunnel.js';
export type {
  Tunnel,
  OpenTunnelOptions,
} from './ssh-tunnel.js';

// --- host-checks -------------------------------------------------------
export {
  checkHostReachable,
  performHealthCheck,
  checkPluginVersions,
  triggerPluginUpdate,
} from './host-checks.js';

// --- post-gate -----------------------------------------------------------
export {
  computeNoFailures,
  computeFullCoverage,
  isScopedDeploy,
  resolvePostSkipReason,
} from './post-gate.js';
export type { MigrationSkipReason } from './post-gate.js';

// --- migration-gate ------------------------------------------------------
export {
  runMigrationPhase,
  siblingIntegrityDirs,
} from './migration-gate.js';
export type { RunPhaseFn, DryRunRenderFn } from './migration-gate.js';

// --- deploy-plan -----------------------------------------------------------
export { resolveDeployPlan } from './deploy-plan.js';
export type { DeployPlan, DeployFlags } from './deploy-plan.js';

// --- deploy-class ------------------------------------------------------
export {
  resolveClass,
  partitionSelectedClasses,
  hasActiveServerMap,
} from './deploy-class.js';
export type { ResolvedClass } from './deploy-class.js';

// --- deploy-config-paths -------------------------------------------------
export {
  resolveConfigPaths,
  resolveConfigPath,
  expandTilde,
} from './deploy-config-paths.js';

// --- deploy-config-validate ----------------------------------------------
export { validateDeployConfig } from './deploy-config-validate.js';
export type { ValidationReport } from './deploy-config-validate.js';

// --- config-store ----------------------------------------------------------
export {
  loadDeployConfigs,
  saveDeployConfigs,
  getConfig,
  configExists,
  listConfigNames,
} from './config-store.js';
export type { ConfigStoreLocation } from './config-store.js';

// --- config-file -----------------------------------------------------------
export { loadConfigFromFile } from './config-file.js';

// --- config-arg --------------------------------------------------------
export { isConfigFilePath } from './config-arg.js';

// --- scheduler-quiesce -------------------------------------------------
export {
  quiesceScheduler,
  schedulerStatus,
  resumeScheduler,
  pollUntilDrained,
} from './scheduler-quiesce.js';
export type {
  QuiesceAvailable,
  QuiesceUnavailable,
  QuiesceResult,
  StatusAvailable,
  StatusUnavailable,
  StatusResult,
  PollResult,
} from './scheduler-quiesce.js';

// --- formatters --------------------------------------------------------
export {
  formatSize,
  formatDuration,
  formatDate,
  formatTime,
  progressBar,
  truncatePath,
  formatCount,
} from './formatters.js';

// --- unified-progress ----------------------------------------------------
export { UnifiedProgress } from './unified-progress.js';
export type {
  HostState,
  HostStatus,
  HostAnalysis,
  UnifiedProgressOptions,
} from './unified-progress.js';

// --- http-client -----------------------------------------------------------
export {
  configureTLS,
  getTLSConfig,
  agentGet,
  agentPostWithStatus,
  agentPost,
  pollDeploymentStatus,
  setEndpointOverride,
  clearEndpointOverride,
  clearAllEndpointOverrides,
  resolveEndpoint,
  buildPluginUrl,
  buildPluginUrlAuto,
  probeHost,
  probeHosts,
  formatConnectionInfo,
  getTLSIndicator,
} from './http-client.js';
export type {
  TLSOptions,
  ConnectionInfo,
  ProgressCallback,
} from './http-client.js';
