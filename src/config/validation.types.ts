import type { PluginManifestRegistry } from "../plugins/manifest-registry.types.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.openclaw.js";
import type { PreparedStrictConfigValidation } from "./validation-prepared.js";

export type ValidateConfigWithPluginsResult =
  | {
      ok: true;
      config: OpenClawConfig;
      warnings: ConfigValidationIssue[];
      strictValidation?: PreparedStrictConfigValidation;
    }
  | { ok: false; issues: ConfigValidationIssue[]; warnings: ConfigValidationIssue[] };

export type PreparedConfigValidationPluginMetadata = {
  manifestRegistry: PluginManifestRegistry;
  installedPluginRecordIds: ReadonlySet<string>;
};
