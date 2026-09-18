import { isDeepStrictEqual } from "node:util";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "./discovery.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import { readPersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";

/** Build metadata once for each distinct inventory, retaining the first workspace's index scope. */
export function selectPluginMetadataWorkspaces(params: {
  workspaceDirs: readonly (string | undefined)[];
  extraPaths: string[];
  installRecords?: Record<string, PluginInstallRecord>;
  stateDir?: string;
  env: NodeJS.ProcessEnv;
}): Array<string | undefined> {
  const store = { env: params.env, stateDir: params.stateDir };
  const installRecords = params.installRecords ?? loadInstalledPluginIndexInstallRecordsSync(store);
  const persistedWorkspace =
    params.installRecords === undefined
      ? readPersistedInstalledPluginIndexSync(store)?.workspaceDir
      : undefined;
  const selected: Array<string | undefined> = [];
  const inventoriesBySources = new Map<string, PluginDiscoveryResult[]>();
  for (const workspaceDir of params.workspaceDirs) {
    const discovery = discoverOpenClawPlugins({
      workspaceDir,
      extraPaths: params.extraPaths,
      installRecords,
      env: params.env,
    });
    // Keep large manifest payloads out of keys; full comparison includes provenance symbols.
    const sources = JSON.stringify([
      // A secondary persisted scope can retain disabled records absent from discovery.
      persistedWorkspace !== params.workspaceDirs[0] && workspaceDir === persistedWorkspace,
      discovery.candidates.map((candidate) => [
        candidate.origin,
        candidate.source,
        candidate.workspaceDir,
        candidate.configSelected,
        candidate.sourcePreferred,
      ]),
      discovery.diagnostics,
    ]);
    const inventories = inventoriesBySources.get(sources);
    if (inventories?.some((inventory) => isDeepStrictEqual(inventory, discovery))) {
      continue;
    }
    if (inventories) {
      inventories.push(discovery);
    } else {
      inventoriesBySources.set(sources, [discovery]);
    }
    selected.push(workspaceDir);
  }
  return selected;
}
