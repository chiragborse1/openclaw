import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import * as sessionPaths from "../config/sessions/paths.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createStatusSessionStoreReader, readStatusSessionStores } from "./session-stores.js";

it("finishes cheap fleet reads without waiting behind every queued background turn", async () => {
  await withOpenClawTestState({ label: "status-read-scheduling" }, async (state) => {
    let workMs = performance.now();
    const clock = vi.spyOn(performance, "now").mockImplementation(() => workMs);
    let backgroundTurns = 0;
    let active = true;
    let scheduled: ReturnType<typeof setImmediate>;
    const background = () => {
      backgroundTurns += 1;
      workMs += 20;
      if (active) {
        scheduled = setImmediate(background);
      }
    };
    scheduled = setImmediate(background);
    const agentIds = Array.from({ length: 600 }, (_, index) => `store-${index}`);
    const read = vi.fn<typeof sessionAccessor.readSessionStoreSummaryAsync>(
      async (_scope, options) => {
        workMs += 0.1;
        return {
          count: 1,
          recent: [],
          byAgent: new Map(options.agentIds.map((agentId) => [agentId, { count: 1, recent: [] }])),
        };
      },
    );
    try {
      const reader = await createStatusSessionStoreReader(
        state.path("{agentId}.sqlite"),
        agentIds,
        10,
        read,
      );
      for (const agentId of agentIds) {
        await expect(reader.read(agentId)).resolves.toMatchObject({
          count: 1,
        });
      }
      expect(reader.stores.size).toBe(600);
      expect(read).toHaveBeenCalledTimes(600);
      expect(backgroundTurns).toBeGreaterThan(0);
      expect(backgroundTurns).toBeLessThan(30);
    } finally {
      active = false;
      clearImmediate(scheduled);
      clock.mockRestore();
      await nextTurn();
    }
  });
});

it("yields during costly fleet preparation before reading the first store", async () => {
  await withOpenClawTestState({ label: "status-preparation-scheduling" }, async (state) => {
    let workMs = performance.now();
    const clock = vi.spyOn(performance, "now").mockImplementation(() => workMs);
    const resolveStore = sessionPaths.resolveSessionStorePathCore;
    const resolve = vi
      .spyOn(sessionPaths, "resolveSessionStorePathCore")
      .mockImplementation((...args) => {
        workMs += 4;
        return resolveStore(...args);
      });
    let backgroundRan = false;
    let firstReadSawBackground: boolean | undefined;
    const readSummary = sessionAccessor.readSessionStoreSummaryAsync;
    const read = vi
      .spyOn(sessionAccessor, "readSessionStoreSummaryAsync")
      .mockImplementation((...args) => {
        firstReadSawBackground ??= backgroundRan;
        return readSummary(...args);
      });
    const scheduled = setImmediate(() => {
      backgroundRan = true;
    });
    const agents = Array.from({ length: 8 }, (_, index) => ({ id: `agent-${index}` }));
    try {
      const result = await readStatusSessionStores(
        { session: { store: state.path("{agentId}.sqlite") } },
        agents,
        10,
      );

      expect(firstReadSawBackground).toBe(true);
      expect(result.paths).toHaveLength(agents.length);
      expect(result.count).toBe(0);
      expect(result.byAgent.map(({ agent, count }) => [agent.id, count])).toEqual(
        agents.map(({ id }) => [id, 0]),
      );
    } finally {
      clearImmediate(scheduled);
      read.mockRestore();
      resolve.mockRestore();
      clock.mockRestore();
      await nextTurn();
    }
  });
});
