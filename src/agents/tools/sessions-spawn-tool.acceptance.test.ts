import { expect, it, vi } from "vitest";
import { mergeAcceptedSessionSpawnsForRun } from "../accepted-session-spawn.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createSessionsSpawnTool } from "./sessions-spawn-tool.js";

vi.mock("../subagents/spawn/subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_CONTEXT_MODES: ["isolated", "fork"],
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: vi.fn(async () => ({
    status: "accepted",
    context: "isolated",
    childSessionKey: "agent:main:subagent:child",
    runId: "child-run",
    expectsCompletionMessage: true,
  })),
}));
vi.mock("../subagents/registry/subagent-registry.js", () => ({
  getSubagentDeliveryBacklogPressure: () => ({ suspended: 0, blocked: false }),
}));

it("retains committed child acceptance when the caller loses its result", async () => {
  const instance = createOperationalRunInstanceRef("spawn-parent");
  await expect(
    withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:main", operationalRunInstance: instance },
      async () => {
        const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:main" });
        await tool.execute("spawn-before-failure", { task: "finish the work" });
        throw new Error("provider transport failed after acceptance");
      },
    ),
  ).rejects.toThrow("provider transport failed");
  expect(mergeAcceptedSessionSpawnsForRun(instance)).toEqual([
    {
      runId: "child-run",
      childSessionKey: "agent:main:subagent:child",
      expectsCompletionMessage: true,
    },
  ]);
  expect(mergeAcceptedSessionSpawnsForRun(createOperationalRunInstanceRef("spawn-parent"))).toEqual(
    [],
  );
});
