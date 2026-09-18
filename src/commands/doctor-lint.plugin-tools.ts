import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listDoctorRuntimeToolSchemaAgentIds } from "../flows/doctor-core-checks.runtime.js";
import type { PluginMetadataSnapshotScopeRunner } from "../plugins/current-plugin-metadata-snapshot.js";
import { withPreparedPluginToolContexts } from "../plugins/tools-preparation.js";

/** Runs inside lint's private state view so metadata and lazy runtime loads share its lifetime. */
export async function withDoctorLintPluginTools<T>(
  config: OpenClawConfig,
  run: (scope: PluginMetadataSnapshotScopeRunner) => Promise<T>,
): Promise<T> {
  return withPreparedPluginToolContexts(
    {
      config,
      workspaceDirs: listDoctorRuntimeToolSchemaAgentIds(config).map((agentId) =>
        resolveAgentWorkspaceDir(config, agentId),
      ),
    },
    run,
  );
}
