# @zincapp/znvault-deploy-core

Target-agnostic deploy machinery shared by znvault deployer plugins (e.g.
[`@zincapp/znvault-plugin-archon`](https://www.npmjs.com/package/@zincapp/znvault-plugin-archon),
`@zincapp/znvault-plugin-payara`). It provides the reusable building blocks a
plugin composes into its own deploy command — none of it is archon- or
payara-specific.

## What it provides

| Area | Exports |
|------|---------|
| **Rollout strategy** | `resolveStrategy`, `executeStrategy`, `parseDeploymentStrategy` (`sequential` / `parallel` / `1+R` canary) |
| **Multi-class deploy** | `executeMultiClassDeployment`, `classGateFailed`, `printMultiClassDryRun`, `printMultiClassSummary` |
| **HAProxy** | `drainServer`, `readyServer`, `setServerState`, `testHAProxyConnectivity`, `getUnmappedHosts` |
| **SSH-CA tunnel** | `openTunnel`, `isLoopbackHost`, `resolveZnvaultBin` |
| **Host checks** | `checkHostReachable`, `performHealthCheck`, `checkPluginVersions`, `triggerPluginUpdate` |
| **Migration gate** | `runMigrationPhase` (parameterized over a plugin-supplied `runPhase` callback) |
| **Quiesce** | `quiesceScheduler`, `resumeScheduler`, `schedulerStatus`, `pollUntilDrained` |
| **Config store** | `loadDeployConfigs`, `saveDeployConfigs`, `getConfig`, `validateDeployConfig`, `resolveClass`, `partitionSelectedClasses` |
| **Agent HTTP client** | `agentGet`, `agentPost`, `buildPluginUrl`, `setEndpointOverride`, `pollDeploymentStatus`, TLS helpers |
| **Coverage/gates** | `computeNoFailures`, `computeFullCoverage`, `isScopedDeploy` |
| **Output** | `UnifiedProgress`, `formatSize`, `formatDuration`, `progressBar`, … |

Plugins parameterize the generic pieces — e.g. `buildPluginUrl(host, port,
tls, pluginNamespace)` and `runMigrationPhase({ runPhase, labels })` — so the
same canary/drain/health-gate/migration flow serves any target.

## Usage

Consumed as a library by a plugin, not run directly:

```ts
import { executeStrategy, drainServer, performHealthCheck, runMigrationPhase }
  from '@zincapp/znvault-deploy-core';
```

## Development

```bash
npm ci
npm run build     # tsc → dist/
npm test
```

Requires Node ≥ 20. Publishes to npm with provenance via OIDC trusted
publishing on a `v*` tag push.
