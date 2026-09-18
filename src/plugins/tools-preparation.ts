import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  withPluginMetadataSnapshotScope,
  type PluginMetadataSnapshotScopeRunner,
} from "./current-plugin-metadata-snapshot.js";
import { acquirePluginRegistryForInspection } from "./loader.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { resolvePluginMetadataSnapshotAsync } from "./plugin-metadata-snapshot.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import {
  buildPluginRuntimeLoadOptions,
  setPluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "./runtime/load-context.resolve.js";

/** Prepare lookup facts once; current-agent policy still selects and invokes tool factories. */
export async function withPreparedPluginToolContexts<T>(
  params: {
    config: OpenClawConfig;
    workspaceDirs: readonly string[];
  },
  run: (scope: PluginMetadataSnapshotScopeRunner) => Promise<T>,
): Promise<T> {
  const env = process.env;
  const cache = createPluginCache();
  const inspections: Array<Awaited<ReturnType<typeof acquirePluginRegistryForInspection>>> = [];
  await using _ = {
    async [Symbol.asyncDispose]() {
      const disposed = await Promise.allSettled(
        inspections.map((inspection) => inspection.release()),
      );
      const failures = disposed.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      try {
        failures.push(...(await retirePluginCache(cache)).failures.map((failure) => failure.error));
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw new AggregateError(failures, "Plugin tool inspection could not confirm cleanup.");
      }
    },
  };
  return await withPluginCache(cache, async () => {
    const scopes = new Map<string, <TResult>(operation: () => TResult) => TResult>();
    for (const workspaceDir of new Set(params.workspaceDirs)) {
      const metadataSnapshot = await resolvePluginMetadataSnapshotAsync({
        config: params.config,
        workspaceDir,
        env,
        allowCurrent: false,
      });
      const resolved = resolvePluginRuntimeLoadContext({
        config: params.config,
        workspaceDir,
        env,
        metadataSnapshot,
      });
      const context = {
        ...resolved,
        config: captureRuntimeConfig(resolved.config),
        activationSourceConfig: captureRuntimeConfig(resolved.activationSourceConfig),
      };
      // An empty owned registry carries facts without loading optional or denied tool owners.
      // Lazy owner modules remain in this operation cache until every detector has settled.
      const inspection = await acquirePluginRegistryForInspection(
        buildPluginRuntimeLoadOptions(context, { onlyPluginIds: [], toolDiscovery: true }),
      );
      inspections.push(inspection);
      setPluginRuntimeLoadContext(inspection.registry, context);
      scopes.set(workspaceDir, (operation) =>
        withPluginMetadataSnapshotScope(
          metadataSnapshot,
          () => withPluginRuntimeRegistryScope(inspection.registry, operation),
          {
            config: params.config,
            compatibleConfigs: [context.config],
            workspaceDir,
            env,
          },
        ),
      );
    }
    const scope: PluginMetadataSnapshotScopeRunner = (request, operation) => {
      const prepared = request.workspaceDir && scopes.get(request.workspaceDir);
      if (request.config !== params.config || !prepared) {
        throw new Error("Plugin tool inspection requested an unprepared config or workspace.");
      }
      return prepared(operation);
    };
    return await run(scope);
  });
}
