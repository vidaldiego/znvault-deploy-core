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
| **Agent HTTP client** | `agentGet`, `agentPost`, `buildPluginUrl`, `setEndpointOverride`, `pollDeploymentStatus`, per-request Bearer auth, TLS helpers |
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

Agent control-plane credentials are passed per request so concurrent hosts can
use distinct tokens without global mutable state:

```ts
const auth = { bearerToken: tokenLoadedFromPrivateFile };
await agentGet(`${pluginUrl}/status`, 10_000, auth);
await agentPost(`${pluginUrl}/restart`, {}, 120_000, auth);
```

The library never loads, persists, or logs the token. Callers must read it from
a private local file and keep the value out of command arguments, environment
variables, URLs, deploy configuration, and diagnostics.

## Development

```bash
npm ci
npm run build     # tsc → dist/
npm test
```

Requires Node ≥ 20. Publishes to npm with provenance via OIDC trusted
publishing on a `v*` tag push.
