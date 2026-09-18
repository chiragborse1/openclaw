import { isDeepStrictEqual } from "node:util";
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { listAgentEntriesWithSource } from "../agents/agent-scope.js";
import type { DeferredPluginMigration } from "../infra/deferred-plugin-migrations.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validatePluginSchemaValue } from "../plugins/schema-validator.js";
import type { OpenClawConfig } from "./types.js";
import { collectHeartbeatOwnerWarnings } from "./validation-core.js";

type SchemaValidationParams = Parameters<typeof validatePluginSchemaValue>[0];
type SchemaValidationResult = ReturnType<typeof validatePluginSchemaValue>;

export type PreparedPluginSchemaValidations = Map<
  string,
  {
    schema: SchemaValidationParams["schema"];
    origin: SchemaValidationParams["origin"];
    input: unknown;
    result: SchemaValidationResult;
  }
>;

export function prepareConfigPluginInputs(config: OpenClawConfig) {
  return {
    agents: listAgentEntriesWithSource(config),
    modelRefs: collectConfiguredModelRefs(config),
    heartbeatWarnings: collectHeartbeatOwnerWarnings(config),
  };
}

export type PreparedConfigPluginInputs = ReturnType<typeof prepareConfigPluginInputs>;

/** Facts from the same core parse and metadata generation as the runtime snapshot. */
export type PreparedStrictConfigValidation = {
  raw: OpenClawConfig;
  config: OpenClawConfig;
  inputs: PreparedConfigPluginInputs;
  schemas: PreparedPluginSchemaValidations;
  manifestRegistry: PluginManifestRegistry;
  installedPluginRecordIds: ReadonlySet<string>;
  deferredPluginMigrations?: readonly DeferredPluginMigration[];
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
};

/** Raw and runtime documents share validation only when their actual schema inputs match. */
export function validatePreparedPluginSchemaValue(
  params: SchemaValidationParams,
  prepared?: PreparedPluginSchemaValidations,
): SchemaValidationResult {
  if (!prepared) {
    return validatePluginSchemaValue(params);
  }
  const previous = prepared.get(params.cacheKey);
  if (
    previous &&
    (previous.schema === params.schema || isDeepStrictEqual(previous.schema, params.schema)) &&
    previous.origin === params.origin &&
    isDeepStrictEqual(previous.input, params.value)
  ) {
    return structuredClone(previous.result);
  }
  const input = structuredClone(params.value);
  const result = validatePluginSchemaValue(params);
  prepared.set(params.cacheKey, {
    schema: params.schema,
    origin: params.origin,
    input,
    result: structuredClone(result),
  });
  return result;
}
