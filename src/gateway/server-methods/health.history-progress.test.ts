import { EventEmitter } from "node:events";
import { setImmediate as flushImmediate } from "node:timers/promises";
import type { Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi, type MockInstance } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { prepareCanonicalSessionReaderAdmission } from "../../config/sessions/session-canonical-key.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  hasOpenClawAgentCanonicalValidation,
  invalidateOpenClawAgentDatabaseValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getHealthCache, refreshGatewayHealthSnapshot } from "../server/health-state.js";
import { readChatHistoryPage } from "./chat-history-pages.js";
import { healthHandlers } from "./health.js";
import type { GatewayRequestContext } from "./types.js";

const observed = vi.hoisted(() => ({
  post: undefined as
    | ((worker: Worker, args: Parameters<Worker["postMessage"]>) => void)
    | undefined,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override postMessage(...args: Parameters<Worker["postMessage"]>): void {
        observed.post?.(this, args);
        super.postMessage(...args);
      }
    },
  };
});

it.each([
  { method: "health", inventory: "admitted", rows: 5, worker: false },
  { method: "health", inventory: "unproven", rows: 5, worker: true },
  { method: "health", inventory: "large", rows: 33, worker: true },
  { method: "status", inventory: "admitted", rows: 5, worker: false },
  { method: "status", inventory: "unproven", rows: 5, worker: true },
  { method: "status", inventory: "large", rows: 33, worker: true },
] as const)(
  "registered $method completes a healthy $inventory inventory while unrelated history is held",
  async ({ method, inventory, rows, worker: workerExpected }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        agents: { defaults: { heartbeat: { every: "0m" } }, entries: { main: {} } },
        plugins: { slots: { memory: "none" } },
      };
      setRuntimeConfigSnapshot(cfg, cfg);
      const scope = { agentId: "main", env: state.env };
      for (let index = 0; index < rows; index++) {
        sessionAccessor.replaceSessionEntrySync(
          { ...scope, sessionKey: `agent:main:row-${index}` },
          { sessionId: `row-${index}`, updatedAt: index + 1 },
        );
      }
      const historyTarget = {
        agentId: "history",
        env: state.env,
        storePath: state.statePath("agents", "history", "sessions", "sessions.json"),
        sessionId: "unrelated-history",
        sessionKey: "agent:history:unrelated-history",
      };
      const entry = { sessionId: historyTarget.sessionId, updatedAt: 1 };
      sessionAccessor.replaceSessionEntrySync(historyTarget, entry);
      await sessionAccessor.replaceTranscriptEvents(historyTarget, [
        { type: "session", version: 3, id: historyTarget.sessionId },
        {
          type: "message",
          id: "history-message",
          parentId: null,
          message: { role: "user", content: "Synthetic unrelated history" },
        },
      ]);
      await sessionAccessor.waitForSessionTranscriptProjection(historyTarget);
      const getRuntimeSnapshot = () => ({ channels: {}, channelAccounts: {} });
      const context: Pick<
        GatewayRequestContext,
        "getHealthCache" | "refreshHealthSnapshot" | "getRuntimeSnapshot" | "logHealth"
      > = {
        getHealthCache,
        refreshHealthSnapshot: (options) =>
          refreshGatewayHealthSnapshot({ ...options, getRuntimeSnapshot }),
        getRuntimeSnapshot,
        logHealth: { error: vi.fn() },
      };
      const invoke = async (respond: ReturnType<typeof vi.fn>) =>
        await healthHandlers[method]!({
          req: {} as never,
          params: { probe: true, includeChannelSummary: false },
          respond: respond as never,
          client: { connect: { role: "operator", scopes: ["operator.read"] } } as never,
          isWebchatConnect: () => false,
          // These registered handlers consume only the typed capabilities above.
          context: context as GatewayRequestContext,
        });
      // Settle normal lazy imports before occupying the unrelated history lane.
      const warmResponse = vi.fn();
      await invoke(warmResponse);
      expect(warmResponse.mock.calls[0]?.[0]).toBe(true);
      const warmSummary = await sessionAccessor.readSessionStoreSummaryAsync(scope, {
        recentLimit: 5,
        agentIds: ["main", ...Array.from({ length: 32 }, (_, index) => `unused-${index}`)],
      });
      expect(warmSummary.count).toBe(rows);
      const database = openOpenClawAgentDatabase(scope);
      if (inventory === "unproven") {
        closeOpenClawAgentDatabaseByPath(database.path);
        expect(
          prepareCanonicalSessionReaderAdmission(openOpenClawAgentDatabase(scope)).input
            .readerAdmission,
        ).toBeUndefined();
        invalidateOpenClawAgentDatabaseValidation(database.path);
        expect(hasOpenClawAgentCanonicalValidation(openOpenClawAgentDatabase(scope))).toBe(false);
      }

      const held = createDeferredCore();
      let historyObserved = false;
      let historyTaskId: unknown;
      let releaseReply: (() => void) | undefined;
      let replies: MockInstance<Worker["emit"]> | undefined;
      let historySettled = false;
      const summaryDispatches: Worker[] = [];
      observed.post = (worker, args) => {
        const request = asOptionalRecord(args[0]);
        const kind = asOptionalRecord(request?.input)?.kind;
        if (kind === "history-page" && !historyObserved) {
          historyObserved = true;
          historyTaskId = request?.taskId;
          replies = vi.spyOn(worker, "emit").mockImplementation((event, ...replyArgs) => {
            const reply = asOptionalRecord(replyArgs[0]);
            if (event === "message" && reply?.taskId === historyTaskId) {
              releaseReply = () => EventEmitter.prototype.emit.call(worker, event, ...replyArgs);
              held.resolve();
              return true;
            }
            return EventEmitter.prototype.emit.call(worker, event, ...replyArgs);
          });
        } else if (kind === "store-summary") {
          summaryDispatches.push(worker);
        }
      };
      const history = readChatHistoryPage({
        entry,
        provider: undefined,
        sessionId: historyTarget.sessionId,
        storePath: historyTarget.storePath,
        sessionAgentId: historyTarget.agentId,
        canonicalKey: historyTarget.sessionKey,
        max: 20,
        maxHistoryBytes: 100_000,
        effectiveMaxChars: 8000,
        offset: undefined,
        messageId: undefined,
      }).finally(() => {
        historySettled = true;
      });
      const entered = createDeferredCore();
      const actualRead = sessionAccessor.readSessionStoreSummaryAsync;
      const read = vi
        .spyOn(sessionAccessor, "readSessionStoreSummaryAsync")
        .mockImplementation((...args) => {
          entered.resolve();
          return actualRead(...args);
        });
      let pending: Promise<void> | undefined;
      let clock: MockInstance<typeof Date.now> | undefined;
      const respond = vi.fn();
      try {
        await Promise.race([
          held.promise,
          history.then(() => {
            throw new Error("History completed without the reply barrier");
          }),
        ]);
        expect(historySettled).toBe(false);
        pending = invoke(respond);
        await entered.promise;
        // Move the collector beyond its 7s deadline without expiring the real 60s pool task.
        clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 8_001);
        await flushImmediate();
        await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce(), { timeout: 1_500 });
        expect(historySettled).toBe(false);
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        expect(respond.mock.calls[0]?.[1].sessions.count).toBe(rows);
        expect(summaryDispatches).toHaveLength(workerExpected ? 1 : 0);
        await pending;
      } finally {
        clock?.mockRestore();
        releaseReply?.();
        await Promise.allSettled([pending, history]);
        read.mockRestore();
        replies?.mockRestore();
        observed.post = undefined;
        if (pending) {
          expect(respond.mock.calls[0]?.[0]).toBe(true);
          expect(respond.mock.calls[0]?.[1].sessions.count).toBe(rows);
        }
        expect((await history).messages).toHaveLength(1);
      }
      expect(historySettled).toBe(true);
    });
  },
);
