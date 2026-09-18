// Anthropic tests cover provider manifest model catalog behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type AnthropicManifestModel = {
  id?: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  mediaInput?: {
    image?: {
      maxSidePx?: number;
      preferredSidePx?: number;
      tokenMode?: string;
    };
  };
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  thinkingLevelMap?: Record<string, string | null>;
};

type AnthropicManifest = {
  modelCatalog?: {
    providers?: Record<string, { models?: AnthropicManifestModel[] }>;
    discovery?: Record<string, string>;
  };
};

const manifest = JSON.parse(
  readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
) as AnthropicManifest;

describe("Anthropic plugin manifest", () => {
  it("publishes Opus 5 without advertising prefix-bound Fable 5.1", () => {
    const models = manifest.modelCatalog?.providers?.anthropic?.models ?? [];
    expect(models.map((model) => model.id)).toContain("claude-opus-5");
    expect(models.map((model) => model.id)).not.toContain("claude-fable-5-1");
  });

  it("publishes the exact Claude Sonnet 5 API contract", () => {
    const models = manifest.modelCatalog?.providers?.anthropic?.models ?? [];
    expect(models.find((model) => model.id === "claude-sonnet-5")).toEqual({
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      reasoning: true,
      input: ["text", "image"],
      mediaInput: {
        image: { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
      },
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    });
  });

  it("publishes the exact Claude Opus 5 API contract", () => {
    const models = manifest.modelCatalog?.providers?.anthropic?.models ?? [];
    expect(models.find((model) => model.id === "claude-opus-5")).toMatchObject({
      id: "claude-opus-5",
      name: "Claude Opus 5",
      reasoning: true,
      input: ["text", "image"],
      mediaInput: {
        image: { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
      },
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    });
    // Opus 5's 1M window is the model default, so the CLI row is not clamped to 200k.
    const cliModels = manifest.modelCatalog?.providers?.["claude-cli"]?.models ?? [];
    expect(cliModels.find((model) => model.id === "claude-opus-5")).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
  });

  it("resolves both official Claude Haiku 4.5 API identifiers from the static catalog", () => {
    expect(manifest.modelCatalog?.discovery?.anthropic).toBe("static");

    const models = manifest.modelCatalog?.providers?.anthropic?.models ?? [];
    for (const id of ["claude-haiku-4-5", "claude-haiku-4-5-20251001"]) {
      expect(models.find((model) => model.id === id)).toEqual({
        id,
        name: "Claude Haiku 4.5",
        reasoning: true,
        input: ["text", "image"],
        mediaInput: {
          image: {
            maxSidePx: 1568,
            preferredSidePx: 1568,
            tokenMode: "provider",
          },
        },
        contextWindow: 200000,
        maxTokens: 64000,
      });
    }
  });
});
