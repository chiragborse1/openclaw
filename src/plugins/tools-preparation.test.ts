import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveOpenClawPluginToolsForOptions } from "../agents/openclaw-plugin-tools.js";
import { normalizeAgentRuntimeTools } from "../agents/runtime-plan/tools.js";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import * as discovery from "./discovery.js";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import * as manifests from "./manifest-registry.js";
import * as metadata from "./plugin-metadata-snapshot.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContext } from "./runtime/load-context.js";
import * as loadContext from "./runtime/load-context.resolve.js";
import { withPreparedPluginToolContexts } from "./tools-preparation.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetPluginLoaderTestStateForTest();
});

describe("prepared plugin tool inspection", () => {
  it.each([false, true])(
    "keeps agent factories and provider hooks with detector failure=%s",
    async (fails) => {
      useNoBundledPlugins();
      const root = tempDirs.make("openclaw-prepared-tool-inspection-");
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      const eventsPath = path.join(root, "events");
      const plugin = writePlugin({
        id: "prepared-tool-fixture",
        dir: path.join(root, "plugin"),
        registration: `
        const fs = require("node:fs");
        const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, event + "\\n");
        record("register");
        api.lifecycle.onDispose(() => record("dispose"));
        api.registerTool((ctx) => {
          record("factory:" + ctx.agentId);
          return { name: "fixture_tool", label: "Fixture", description: "Fixture",
            parameters: { type: "object", properties: { agent: { type: "string", const: ctx.agentId } } },
            execute: async () => ({ content: [], details: {} }) };
        }, { name: "fixture_tool" });
        api.registerProvider({ id: "fixture-provider", label: "Fixture", auth: [],
          normalizeToolSchemas(ctx) { record("normalize"); return ctx.tools; } });
      `,
      });
      fs.writeFileSync(
        path.join(plugin.dir, "openclaw.plugin.json"),
        JSON.stringify({
          id: plugin.id,
          configSchema: { type: "object", properties: {}, additionalProperties: false },
          providers: ["fixture-provider"],
          contracts: { tools: ["fixture_tool"] },
        }),
      );
      const config = captureRuntimeConfig({
        agents: { defaults: { model: { primary: "fixture-provider/fixture-model" } } },
        plugins: { allow: [plugin.id], load: { paths: [plugin.file] } },
      });
      const first = path.join(root, "first");
      const second = path.join(root, "second");
      const prepare = vi.spyOn(metadata, "resolvePluginMetadataSnapshotAsync");
      const activate = vi.spyOn(loadContext, "resolvePluginRuntimeLoadContext");
      const registries: unknown[] = [];
      const primaryFailure = new Error("detector failed");
      const operation = withPreparedPluginToolContexts(
        { config, workspaceDirs: [first, first, second] },
        async (scope) => {
          expect(fs.existsSync(eventsPath)).toBe(false);
          const coldDiscovery = vi
            .spyOn(discovery, "discoverOpenClawPlugins")
            .mockImplementation(() => {
              throw new Error("cold discovery inside detector");
            });
          const coldManifests = vi
            .spyOn(manifests, "loadPluginManifestRegistryCore")
            .mockImplementation(() => {
              throw new Error("cold manifest loading inside detector");
            });
          try {
            for (const [agentId, workspaceDir] of [
              ["alpha", first],
              ["beta", first],
              ["gamma", second],
            ]) {
              await scope({ config, workspaceDir }, async () => {
                const registry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
                registries.push(registry);
                expect(
                  getPluginRuntimeLoadContext(registry)?.config.plugins?.entries?.[plugin.id]
                    ?.enabled,
                ).toBe(true);
                expect(config.plugins?.entries?.[plugin.id]).toBeUndefined();
                const tools = resolveOpenClawPluginToolsForOptions({
                  options: {
                    config,
                    workspaceDir,
                    requesterAgentIdOverride: agentId,
                    pluginToolAllowlist: ["fixture_tool"],
                  },
                  resolvedConfig: config,
                });
                expect(tools.map((tool) => tool.name)).toEqual(["fixture_tool"]);
                expect(tools[0]?.parameters).toMatchObject({
                  properties: { agent: { const: agentId } },
                });
                expect(
                  normalizeAgentRuntimeTools({
                    tools,
                    provider: "fixture-provider",
                    modelId: "fixture-model",
                    config,
                    workspaceDir,
                  }),
                ).toHaveLength(1);
              });
            }
            expect(coldDiscovery).not.toHaveBeenCalled();
            expect(coldManifests).not.toHaveBeenCalled();
            if (fails) {
              throw primaryFailure;
            }
          } finally {
            coldDiscovery.mockRestore();
            coldManifests.mockRestore();
          }
        },
      );
      if (fails) {
        await expect(operation).rejects.toBe(primaryFailure);
      } else {
        await operation;
      }
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(activate).toHaveBeenCalledTimes(2);
      expect(registries[0]).toBeDefined();
      expect(registries[0]).toBe(registries[1]);
      expect(registries[2]).not.toBe(registries[0]);
      const events = fs.readFileSync(eventsPath, "utf8").trim().split("\n");
      expect(events.filter((event) => event.startsWith("factory:"))).toEqual([
        "factory:alpha",
        "factory:beta",
        "factory:gamma",
      ]);
      expect(events.filter((event) => event === "normalize")).toHaveLength(3);
      expect(events.filter((event) => event === "dispose")).toHaveLength(
        events.filter((event) => event === "register").length,
      );
      expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
    },
  );
});
