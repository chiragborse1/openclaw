import { channel } from "node:diagnostics_channel";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { serializeNativeErrorResponse } from "../../infra/native-error-response.js";
import {
  getWorkerComputeCapacity,
  type WorkerComputePermit,
} from "../../infra/worker-task-capacity.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as readonlyOwner from "../../state/openclaw-agent-db-readonly.js";
import {
  hasOpenClawAgentCanonicalValidation,
  invalidateOpenClawAgentDatabaseValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  readSessionStoreSummaryAsync,
  listSessionEntriesReadOnly,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { setCanonicalSqliteSessionMainKey } from "./session-canonical-key.js";
import { prepareSessionEntryPresenceRead } from "./session-transcript-worker-runtime.js";

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

const tempDirs = createTempDirTracker();
const summaryOptions = { recentLimit: 2, agentIds: ["main"] };
const workerSummaryOptions = {
  ...summaryOptions,
  agentIds: ["main", ...Array.from({ length: 32 }, (_, index) => `unused-${index}`)],
};

function summaryFixture() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("session-summary-admission-") };
  const scope = { agentId: "main", env, sessionKey: "agent:main:visible" };
  replaceSessionEntrySync(scope, { sessionId: "visible", updatedAt: 20 });
  replaceSessionEntrySync(
    { ...scope, sessionKey: "agent:main:sibling" },
    { sessionId: "sibling", updatedAt: 10 },
  );
  const database = openOpenClawAgentDatabase(scope);
  const recent = [
    {
      sessionKey: scope.sessionKey,
      entry: { sessionId: "visible", updatedAt: 20, delivery: { kind: "none" } },
    },
    {
      sessionKey: "agent:main:sibling",
      entry: { sessionId: "sibling", updatedAt: 10, delivery: { kind: "none" } },
    },
  ];
  return {
    scope,
    database,
    expected: { count: 2, recent, byAgent: new Map([["main", { count: 2, recent }]]) },
  };
}

function isSummaryDispatch([message]: Parameters<Worker["postMessage"]>): boolean {
  return asOptionalRecord(asOptionalRecord(message)?.input)?.kind === "store-summary";
}

function corruptSibling(databasePath: string) {
  const external = new DatabaseSync(databasePath);
  try {
    external
      .prepare("UPDATE session_nodes SET entry_json = '{' WHERE session_key = ?")
      .run("agent:main:sibling");
  } finally {
    external.close();
  }
}

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("session summary worker", () => {
  it.each([
    { rows: 32, windows: 32, worker: false },
    { rows: 33, windows: 32, worker: true },
    { rows: 32, windows: 33, worker: true },
  ])(
    "bounds local inventory at $rows rows and $windows windows",
    async ({ rows, windows, worker }) => {
      const { scope } = summaryFixture();
      for (let index = 2; index < rows; index++) {
        replaceSessionEntrySync(
          { ...scope, sessionKey: `agent:main:extra-${index}` },
          { sessionId: `extra-${index}`, updatedAt: index },
        );
      }
      const options = {
        recentLimit: 2,
        agentIds: ["main", ...Array.from({ length: windows - 1 }, (_, index) => `unused-${index}`)],
      };
      const recent = [rows - 1, rows - 2].map((index) => ({
        sessionKey: `agent:main:extra-${index}`,
        entry: { sessionId: `extra-${index}`, updatedAt: index, delivery: { kind: "none" } },
      }));
      const expected = {
        count: rows,
        recent,
        byAgent: new Map(
          options.agentIds.map((id) => [
            id,
            id === "main" ? { count: rows, recent } : { count: 0, recent: [] },
          ]),
        ),
      };
      const dispatch = vi.spyOn(Worker.prototype, "postMessage");
      try {
        const result = await readSessionStoreSummaryAsync(scope, options);
        expect(result).toEqual(expected);
        expect(result.count).toBe(rows);
        expect(dispatch.mock.calls.filter(isSummaryDispatch)).toHaveLength(worker ? 1 : 0);
      } finally {
        dispatch.mockRestore();
      }
    },
  );

  it("keeps bounded whole-store and retired-agent aggregates on the retained reader", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("session-summary-bounded-shared-") };
    const storePath = path.join(env.OPENCLAW_STATE_DIR, "shared.sqlite");
    openOpenClawAgentDatabase({ agentId: "main", env, path: storePath });
    const owners = ["main", "worker", "retired", "main", "worker"];
    const keys = owners.map((agentId, index) => `agent:${agentId}:row-${index}`);
    for (const [index, agentId] of owners.entries()) {
      replaceSessionEntrySync(
        { agentId, env, storePath, sessionKey: keys[index]! },
        { sessionId: `row-${index}`, updatedAt: index + 1 },
      );
    }
    const dispatch = vi.spyOn(Worker.prototype, "postMessage");
    try {
      const result = await readSessionStoreSummaryAsync(
        { agentId: "main", env, storePath },
        { agentIds: ["main", "worker"], recentLimit: 5 },
      );
      expect(result.count).toBe(5);
      expect(result.recent.map(({ sessionKey }) => sessionKey)).toEqual(keys.toReversed());
      expect([...result.byAgent.keys()]).toEqual(["main", "worker"]);
      expect(result.byAgent.get("main")?.count).toBe(2);
      expect(result.byAgent.get("worker")?.recent.map(({ sessionKey }) => sessionKey)).toEqual([
        keys[4],
        keys[1],
      ]);
      expect(dispatch.mock.calls.filter(isSummaryDispatch)).toHaveLength(0);
    } finally {
      dispatch.mockRestore();
    }
  });

  it.each([0, 1])(
    "selects the worker only after the 64KiB text budget is exceeded by %i byte",
    async (extraByte) => {
      const { scope, database, expected: initial } = summaryFixture();
      listSessionEntriesReadOnly(scope);
      const record = { sessionId: "visible", updatedAt: 20, label: "" };
      const update = database.db.prepare(
        "UPDATE session_nodes SET entry_json = ? WHERE session_key = ?",
      );
      update.run(JSON.stringify(record), scope.sessionKey);
      const baseBytes =
        Buffer.byteLength("main") +
        database.db
          .prepare("SELECT session_key, entry_json FROM session_nodes")
          .all()
          .reduce((total, row) => {
            if (typeof row.session_key !== "string" || typeof row.entry_json !== "string") {
              throw new Error("Invalid fixture row");
            }
            return total + Buffer.byteLength(row.session_key) + Buffer.byteLength(row.entry_json);
          }, 0);
      record.label = "x".repeat(64 * 1024 - baseBytes + extraByte);
      update.run(JSON.stringify(record), scope.sessionKey);
      const recent = [{ sessionKey: scope.sessionKey, entry: record }, initial.recent[1]!];
      const expected = { count: 2, recent, byAgent: new Map([["main", { count: 2, recent }]]) };
      const dispatch = vi.spyOn(Worker.prototype, "postMessage");
      try {
        expect(await readSessionStoreSummaryAsync(scope, summaryOptions)).toEqual(expected);
        expect(dispatch.mock.calls.filter(isSummaryDispatch)).toHaveLength(extraByte);
      } finally {
        dispatch.mockRestore();
      }
    },
  );

  it.each([128, 129])("bounds local participant fanout at %i rows", async (participants) => {
    const { scope, database, expected: initial } = summaryFixture();
    const insert = database.db.prepare(
      "INSERT INTO session_participants VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (let index = 0; index < participants; index++) {
      insert.run(
        scope.sessionKey,
        JSON.stringify({ type: "profile" }),
        `person-${index}`,
        1,
        index,
        index,
      );
    }
    const recent = [
      {
        sessionKey: scope.sessionKey,
        entry: {
          ...initial.recent[0]!.entry,
          participants: Array.from({ length: participants }, (_, index) => ({
            identity: { type: "profile", id: `person-${index}` },
          })),
          participantCount: participants,
        },
      },
      initial.recent[1]!,
    ];
    const expected = { count: 2, recent, byAgent: new Map([["main", { count: 2, recent }]]) };
    const dispatch = vi.spyOn(Worker.prototype, "postMessage");
    try {
      const result = await readSessionStoreSummaryAsync(scope, summaryOptions);
      expect(result).toEqual(expected);
      expect(result.recent[0]?.entry.participantCount).toBe(participants);
      expect(dispatch.mock.calls.filter(isSummaryDispatch)).toHaveLength(
        participants > 128 ? 1 : 0,
      );
    } finally {
      dispatch.mockRestore();
    }
  });

  it.each(["entry", "owner", "participant"] as const)(
    "offloads oversized %s bytes before local payload decoding",
    async (source) => {
      const { scope, database, expected: initial } = summaryFixture();
      listSessionEntriesReadOnly(scope);
      const large = "🦞".repeat(17_000);
      let encoded: string | undefined;
      if (source === "entry") {
        encoded = JSON.stringify({ sessionId: "visible", updatedAt: 20, label: large });
        database.db
          .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
          .run(encoded, scope.sessionKey);
      } else if (source === "owner") {
        database.db
          .prepare(
            "UPDATE session_nodes SET owner_actor_type = 'human', owner_actor_id = ? WHERE session_key = ?",
          )
          .run(large, scope.sessionKey);
      } else {
        database.db
          .prepare("INSERT INTO session_participants VALUES (?, ?, ?, 1, 1, 1)")
          .run(scope.sessionKey, JSON.stringify({ type: "profile" }), large);
      }
      const visible =
        source === "entry"
          ? { sessionId: "visible", updatedAt: 20, label: large }
          : source === "owner"
            ? { ...initial.recent[0]!.entry, owner: { actor: { type: "human", id: large } } }
            : {
                ...initial.recent[0]!.entry,
                participants: [{ identity: { type: "profile", id: large } }],
                participantCount: 1,
              };
      const recent = [{ sessionKey: scope.sessionKey, entry: visible }, initial.recent[1]!];
      const expected = { count: 2, recent, byAgent: new Map([["main", { count: 2, recent }]]) };
      const dispatch = vi.spyOn(Worker.prototype, "postMessage");
      const parse = vi.spyOn(JSON, "parse");
      try {
        expect(await readSessionStoreSummaryAsync(scope, summaryOptions)).toEqual(expected);
        expect(dispatch.mock.calls.filter(isSummaryDispatch)).toHaveLength(1);
        if (encoded) {
          expect(parse.mock.calls.some(([text]) => text === encoded)).toBe(false);
        }
      } finally {
        parse.mockRestore();
        dispatch.mockRestore();
      }
    },
  );

  it("propagates a bounded projection error without dispatching another route", async () => {
    const { scope, database } = summaryFixture();
    database.db
      .prepare("INSERT INTO session_participants VALUES (?, ?, ?, 1, 1, 1)")
      .run(scope.sessionKey, "{", "person");
    const dispatch = vi.spyOn(Worker.prototype, "postMessage");
    try {
      await expect(readSessionStoreSummaryAsync(scope, summaryOptions)).rejects.toBeInstanceOf(
        SyntaxError,
      );
      expect(dispatch.mock.calls.filter(isSummaryDispatch)).toHaveLength(0);
    } finally {
      dispatch.mockRestore();
    }
  });

  it("sends an unproven physical generation to the worker before scanning", async () => {
    const { scope, database, expected } = summaryFixture();
    const dispatch = vi.spyOn(Worker.prototype, "postMessage");
    invalidateOpenClawAgentDatabaseValidation(database.path);
    const pending = readSessionStoreSummaryAsync(scope, summaryOptions);
    try {
      expect(await pending).toEqual(expected);
      expect(dispatch.mock.calls.filter(isSummaryDispatch)).toHaveLength(1);
    } finally {
      await Promise.allSettled([pending]);
      dispatch.mockRestore();
    }
  });

  it("keeps an unproven summary pending beyond 60 seconds of shared compute contention", async () => {
    const { scope, database, expected } = summaryFixture();
    invalidateOpenClawAgentDatabaseValidation(database.path);
    const capacity = getWorkerComputeCapacity();
    const entered = createDeferredCore();
    const permits: WorkerComputePermit[] = [];
    const releaseCapacity = () => {
      for (const permit of permits.splice(0)) {
        capacity.release(permit);
      }
    };
    const dispatch = vi.spyOn(Worker.prototype, "postMessage");
    let pending: Promise<unknown> | undefined;
    let outcome: unknown;
    try {
      for (let index = 0; index < Math.max(1, availableParallelism() - 1); index++) {
        const permit = capacity.acquire(
          () => {},
          () => {
            entered.resolve();
            return false;
          },
        );
        if (!permit) {
          throw new Error("Expected idle shared compute capacity before the summary");
        }
        permits.push(permit);
      }
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      pending = readSessionStoreSummaryAsync(scope, summaryOptions).then(
        (value) => {
          outcome = { ok: true, value };
          return outcome;
        },
        (error: unknown) => {
          outcome = { ok: false, error };
          return outcome;
        },
      );
      await entered.promise;
      await vi.advanceTimersByTimeAsync(60_001);
      expect(dispatch.mock.calls.filter(isSummaryDispatch)).toHaveLength(0);
      expect(outcome).toBeUndefined();
      vi.useRealTimers();
      releaseCapacity();
      await expect(pending).resolves.toEqual({ ok: true, value: expected });
      expect(dispatch.mock.calls.filter(isSummaryDispatch)).toHaveLength(1);
      await expect(
        closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId),
      ).resolves.toBe(true);
      expect(database.db.isOpen).toBe(false);
    } finally {
      vi.useRealTimers();
      releaseCapacity();
      await Promise.allSettled([pending]);
      dispatch.mockRestore();
    }
  });

  it("uses a committed reader when a borrowed writer enters a transaction before dispatch", async () => {
    const { scope, database, expected: initial } = summaryFixture();
    const expected = {
      ...initial,
      byAgent: new Map(
        workerSummaryOptions.agentIds.map((id) => [
          id,
          id === "main" ? { count: 2, recent: initial.recent } : { count: 0, recent: [] },
        ]),
      ),
    };
    const pending = readSessionStoreSummaryAsync(scope, workerSummaryOptions);
    database.db.exec("BEGIN");
    database.db.prepare("DELETE FROM session_nodes WHERE session_key = ?").run(scope.sessionKey);
    try {
      expect(await pending).toEqual(expected);
    } finally {
      database.db.exec("ROLLBACK");
      await Promise.allSettled([pending]);
    }
  });

  it.each([false, true])(
    "preserves admitted pending-row summaries on the first async read (shared=%s)",
    async (shared) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("session-summary-worker-pending-") };
      const agentId = shared ? "worker-1" : "main";
      const storePath = shared ? path.join(env.OPENCLAW_STATE_DIR, "shared.sqlite") : undefined;
      const database = openOpenClawAgentDatabase({ agentId: "main", env, path: storePath });
      const scope = { agentId, env, storePath };
      for (const [key, updatedAt] of [
        ["pending", 10],
        ["bad-json", 15],
        ["settled", 20],
      ] as const) {
        replaceSessionEntrySync(
          { ...scope, sessionKey: `agent:${agentId}:${key}` },
          { sessionId: key, updatedAt },
        );
      }
      const options = { recentLimit: 2, agentIds: shared ? ["main", agentId] : [agentId] };
      // Admit only the existing parent reader before introducing pending raw rows.
      expect(listSessionEntriesReadOnly(scope)).toHaveLength(3);
      const update = database.db.prepare(
        "UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?",
      );
      const pendingKey = `agent:${agentId}:pending`;
      update.run(
        JSON.stringify({ sessionId: "pending-updated", updatedAt: 30, label: "fresh" }),
        30,
        pendingKey,
      );
      update.run("{", 40, `agent:${agentId}:bad-json`);
      expect(
        database.db
          .prepare(
            "SELECT current_session_id, entry_valid FROM session_nodes WHERE session_key = ?",
          )
          .get(pendingKey),
      ).toEqual({ current_session_id: "pending", entry_valid: 0 });

      const recent = [
        {
          sessionKey: pendingKey,
          entry: { sessionId: "pending-updated", updatedAt: 30, label: "fresh" },
        },
        {
          sessionKey: `agent:${agentId}:settled`,
          entry: { sessionId: "settled", updatedAt: 20, delivery: { kind: "none" } },
        },
      ];
      const expected = {
        count: 2,
        recent,
        byAgent: new Map(
          options.agentIds.map((id) => [
            id,
            id === agentId ? { count: 2, recent } : { count: 0, recent: [] },
          ]),
        ),
      };
      await expect(readSessionStoreSummaryAsync(scope, options)).resolves.toEqual(expected);
    },
  );

  it("captures each shared owner, path, environment, and window before awaiting the worker", async () => {
    const firstEnv = { OPENCLAW_STATE_DIR: tempDirs.make("session-summary-worker-first-") };
    const secondEnv = { OPENCLAW_STATE_DIR: tempDirs.make("session-summary-worker-second-") };
    const scopes = [firstEnv, secondEnv].map((env) => ({
      agentId: "worker-1",
      env,
      storePath: path.join(env.OPENCLAW_STATE_DIR, "shared.sqlite"),
    }));
    for (const [index, scope] of scopes.entries()) {
      openOpenClawAgentDatabase({ agentId: "main", env: scope.env, path: scope.storePath });
      replaceSessionEntrySync(
        { ...scope, sessionKey: "agent:worker-1:visible" },
        { sessionId: `store-${index}`, updatedAt: index + 1 },
      );
    }
    const firstScope = scopes[0]!;
    const secondScope = scopes[1]!;
    const options = { recentLimit: 1, agentIds: ["main", "worker-1"] };
    expect((await readSessionStoreSummaryAsync(firstScope, options)).recent).toEqual([
      {
        sessionKey: "agent:worker-1:visible",
        entry: { sessionId: "store-0", updatedAt: 1, delivery: { kind: "none" } },
      },
    ]);

    const pending = readSessionStoreSummaryAsync(secondScope, options);
    secondScope.agentId = "changed";
    secondScope.storePath = firstScope.storePath;
    secondScope.env.OPENCLAW_STATE_DIR = firstEnv.OPENCLAW_STATE_DIR;
    options.recentLimit = 0;
    options.agentIds.length = 0;
    const recent = [
      {
        sessionKey: "agent:worker-1:visible",
        entry: { sessionId: "store-1", updatedAt: 2, delivery: { kind: "none" } },
      },
    ];
    await expect(pending).resolves.toEqual({
      count: 1,
      recent,
      byAgent: new Map([
        ["main", { count: 0, recent: [] }],
        ["worker-1", { count: 1, recent }],
      ]),
    });
  });

  it.each([
    { warmWorker: "summary", parent: "absent" },
    { warmWorker: "summary", parent: "physical-ready-only" },
    { warmWorker: "history", parent: "absent" },
    { warmWorker: "history", parent: "physical-ready-only" },
  ] as const)(
    "does not borrow $warmWorker worker warmth for a $parent parent",
    async ({ warmWorker, parent }) => {
      const { scope, database } = summaryFixture();
      const databasePath = database.path;
      expect(hasOpenClawAgentCanonicalValidation(database)).toBe(true);
      closeOpenClawAgentDatabaseByPath(databasePath);
      if (warmWorker === "summary") {
        expect(
          (
            await readSessionStoreSummaryAsync(scope, {
              ...summaryOptions,
              agentIds: ["main", ...Array.from({ length: 32 }, (_, index) => `unused-${index}`)],
            })
          ).count,
        ).toBe(2);
      } else {
        expect(await prepareSessionEntryPresenceRead(scope).read()).toBe(true);
      }
      if (parent === "physical-ready-only") {
        expect(hasOpenClawAgentCanonicalValidation(openOpenClawAgentDatabase(scope))).toBe(true);
      }
      corruptSibling(databasePath);
      await expect(readSessionStoreSummaryAsync(scope, summaryOptions)).rejects.toThrow(
        "openclaw doctor --fix",
      );
    },
  );

  it.each(["synchronous", "worker"] as const)(
    "preserves admitted parsing and fresh-reader validation after a %s snapshot",
    async (mode) => {
      const { scope, database, expected } = summaryFixture();
      closeOpenClawAgentDatabaseByPath(database.path);
      invalidateOpenClawAgentDatabaseValidation(database.path);
      const reopened = openOpenClawAgentDatabase(scope);
      const reopenedHandle = reopened.db;
      expect(hasOpenClawAgentCanonicalValidation(reopened)).toBe(false);
      let firstWorker: Worker | undefined;
      let observation: unknown;
      let onReply: ((message: unknown) => void) | undefined;
      let pending: ReturnType<typeof readSessionStoreSummaryAsync> | undefined;
      try {
        if (mode === "worker") {
          observed.post = (worker, args) => {
            if (!firstWorker && isSummaryDispatch(args)) {
              firstWorker = worker;
              const taskId = asOptionalRecord(args[0])?.taskId;
              onReply = (message) => {
                const reply = asOptionalRecord(message);
                const body = asOptionalRecord(reply?.value);
                const result = asOptionalRecord(body?.value);
                if (
                  reply?.taskId !== taskId ||
                  reply?.status !== "ok" ||
                  body?.ok !== true ||
                  result?.kind !== "store-summary"
                ) {
                  return;
                }
                try {
                  observation = {
                    admission: result.admission,
                    parentReady: hasOpenClawAgentCanonicalValidation(reopened),
                  };
                  corruptSibling(reopened.path);
                } catch (error) {
                  observation = { error };
                }
              };
              // Observe the completed snapshot before the pool accepts its reply.
              worker.prependOnceListener("message", onReply);
            }
          };
          pending = readSessionStoreSummaryAsync(scope, summaryOptions);
          await expect(pending).resolves.toEqual(expected);
          expect(observation).toEqual({
            admission: { mainKey: "main", fullValidation: true },
            parentReady: false,
          });
        } else {
          expect(listSessionEntriesReadOnly(scope)).toEqual([
            expected.recent[1],
            expected.recent[0],
          ]);
          corruptSibling(reopened.path);
        }
        expect(hasOpenClawAgentCanonicalValidation(reopened)).toBe(true);
        const recent = [expected.recent[0]!];
        await expect(readSessionStoreSummaryAsync(scope, summaryOptions)).resolves.toEqual({
          count: 1,
          recent,
          byAgent: new Map([["main", { count: 1, recent }]]),
        });
        await closeOpenClawAgentDatabaseByPathAsync(reopened.path, reopened.agentId);
        const fresh = openOpenClawAgentDatabase(scope);
        expect(reopenedHandle.isOpen).toBe(false);
        expect(fresh.db.isOpen).toBe(true);
        expect(fresh.db === reopenedHandle).toBe(false);
        expect(hasOpenClawAgentCanonicalValidation(fresh)).toBe(true);
        await expect(readSessionStoreSummaryAsync(scope, summaryOptions)).rejects.toThrow(
          "openclaw doctor --fix",
        );
      } finally {
        await Promise.allSettled([pending]);
        if (firstWorker && onReply) {
          firstWorker.off("message", onReply);
        }
        observed.post = undefined;
      }
    },
  );

  it("preserves canonical schema repair guidance before async reader admission", async () => {
    const { scope, database } = summaryFixture();
    database.db.exec("DROP TABLE session_key_contract");

    await expect(readSessionStoreSummaryAsync(scope, summaryOptions)).rejects.toThrow(
      "run openclaw doctor --fix",
    );
  });

  it.each([false, true])(
    "keeps concurrent summaries current across equivalent admission publication (cold=%s)",
    async (cold) => {
      const { scope, database, expected } = summaryFixture();
      listSessionEntriesReadOnly(scope);
      if (cold) {
        closeOpenClawAgentDatabaseByPath(database.path);
        openOpenClawAgentDatabase(scope);
      }
      const first = readSessionStoreSummaryAsync(scope, summaryOptions);
      const second = readSessionStoreSummaryAsync(scope, summaryOptions);
      const third = first.then(() => readSessionStoreSummaryAsync(scope, summaryOptions));
      try {
        await expect(Promise.all([first, second, third])).resolves.toEqual([
          expected,
          expected,
          expected,
        ]);
      } finally {
        await Promise.allSettled([first, second, third]);
      }
    },
  );

  it("resolves caller environment lookups before creating the worker copy", async () => {
    const { scope, expected } = summaryFixture();
    // Windows process.env preserves original spelling while resolving keys case-insensitively.
    const env = new Proxy(
      { OpenClaw_State_Dir: scope.env.OPENCLAW_STATE_DIR },
      {
        get: (target, key, receiver) =>
          key === "OPENCLAW_STATE_DIR"
            ? target.OpenClaw_State_Dir
            : Reflect.get(target, key, receiver),
      },
    );
    const target = { ...scope, env };
    await expect(readSessionStoreSummaryAsync(target, summaryOptions)).resolves.toEqual(expected);
  });

  it("preserves history reader admission across an independent cold summary", async () => {
    const { scope, database } = summaryFixture();
    const databasePath = database.path;
    closeOpenClawAgentDatabaseByPath(databasePath);
    const history = prepareSessionEntryPresenceRead(scope);
    expect(await history.read()).toBe(true);
    expect((await readSessionStoreSummaryAsync(scope, summaryOptions)).count).toBe(2);
    corruptSibling(databasePath);
    await expect(history.read()).resolves.toBe(true);
  });

  it("fully validates a cold physical owner even when an imported pending table is empty", async () => {
    const { scope, database } = summaryFixture();
    const databasePath = database.path;
    closeOpenClawAgentDatabasesForTest();
    const reopened = openOpenClawAgentDatabase(scope);
    expect(hasOpenClawAgentCanonicalValidation(reopened)).toBe(false);
    corruptSibling(databasePath);
    reopened.db.prepare("UPDATE session_nodes SET entry_valid = 1").run();
    reopened.db.prepare("DELETE FROM session_canonical_validation_pending").run();
    await expect(readSessionStoreSummaryAsync(scope, summaryOptions)).rejects.toThrow(
      "openclaw doctor --fix",
    );
  });

  it.each([false, true])(
    "joins revoked summary work while the worker runtime import is pending (cached=%s)",
    async (cached) => {
      const { scope, database } = summaryFixture();
      if (!cached) {
        closeOpenClawAgentDatabaseByPath(database.path);
      }
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      // Delay module availability, then forward the actual worker/runtime exports.
      vi.doMock("./session-transcript-worker-runtime.js", async (importOriginal) => {
        entered.resolve();
        await resume.promise;
        return await importOriginal<typeof import("./session-transcript-worker-runtime.js")>();
      });
      const retained = vi.spyOn(readonlyOwner, "retainOpenClawAgentDatabaseReadOnly");
      const pending = readSessionStoreSummaryAsync(scope, workerSummaryOptions);
      let closing: Promise<boolean> | undefined;
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Summary returned before the worker import barrier");
          }),
        ]);
        const opened = retained.mock.results[0];
        if (opened?.type !== "return" || !opened.value.found) {
          throw new Error("Expected the real retained parent reader");
        }
        expect(opened.value.database.db.isOpen).toBe(true);
        let closed = false;
        closing = closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId).then(
          (value) => {
            closed = true;
            return value;
          },
        );
        expect(opened.value.claim.isCurrent()).toBe(false);
        await Promise.resolve();
        expect(closed).toBe(false);
        resume.resolve();
        await expect(pending).rejects.toThrow("revoked");
        await expect(closing).resolves.toBe(cached);
        expect(opened.value.database.db.isOpen).toBe(false);
      } finally {
        resume.resolve();
        await Promise.allSettled([pending, closing]);
        retained.mockRestore();
        vi.doUnmock("./session-transcript-worker-runtime.js");
      }
    },
  );

  it.each([
    { phase: "local", mutation: "close" },
    { phase: "local", mutation: "replace" },
    { phase: "local", mutation: "main-key" },
    { phase: "queued", mutation: "close" },
    { phase: "queued", mutation: "replace" },
    { phase: "queued", mutation: "main-key" },
    { phase: "returned", mutation: "close" },
    { phase: "returned", mutation: "replace" },
    { phase: "returned", mutation: "main-key" },
  ] as const)(
    "rejects a $mutation owner change while the summary is $phase",
    async ({ phase, mutation }) => {
      const blocker = phase === "queued" ? summaryFixture() : undefined;
      const { scope, database } = summaryFixture();
      listSessionEntriesReadOnly(scope);
      const replacementPath = `${database.path}.replacement`;
      if (mutation === "replace") {
        database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        fs.copyFileSync(database.path, replacementPath);
      }
      let changed = false;
      let closing: Promise<boolean> | undefined;
      const diagnostics = channel("openclaw.worker.task");
      const changeOwner = () => {
        changed = true;
        if (mutation === "close") {
          closing = closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId);
        } else if (mutation === "replace") {
          fs.renameSync(replacementPath, database.path);
        } else {
          setCanonicalSqliteSessionMainKey(database, "alternate");
        }
      };
      const onCompletion = (message: unknown) => {
        const event = asOptionalRecord(message);
        if (
          changed ||
          event?.outcome !== "ok" ||
          typeof event.worker !== "string" ||
          !event.worker.startsWith("session-transcript.worker.")
        ) {
          return;
        }
        changeOwner();
      };
      diagnostics.subscribe(onCompletion);
      const earlier = blocker
        ? readSessionStoreSummaryAsync(blocker.scope, workerSummaryOptions)
        : undefined;
      const pending = readSessionStoreSummaryAsync(
        scope,
        phase === "local" ? summaryOptions : workerSummaryOptions,
      );
      if (phase === "local") {
        changeOwner();
      }
      try {
        await expect(pending).rejects.toThrow(/no longer current|revoked/);
        expect(changed).toBe(true);
        if (earlier) {
          expect((await earlier).count).toBe(2);
        }
        if (closing) {
          await expect(closing).resolves.toBe(true);
        }
      } finally {
        diagnostics.unsubscribe(onCompletion);
        await Promise.allSettled([pending, earlier, closing]);
      }
    },
  );

  it.each(["native-close-error", "wrong-kind", "retirement-failure"] as const)(
    "joins summary worker retirement after a %s reply before dispatching its successor",
    async (failure) => {
      const { scope, database } = summaryFixture();
      const successorScope = summaryFixture().scope;
      let firstWorker: Worker | undefined;
      let firstTaskId: unknown;
      let retiredAtSuccessor = false;
      const retirementEntered = createDeferredCore();
      const releaseRetirement = createDeferredCore();
      let terminating: MockInstance<Worker["terminate"]> | undefined;
      let replies: MockInstance<Worker["emit"]> | undefined;
      let closing: Promise<boolean> | undefined;
      observed.post = (worker, args) => {
        if (isSummaryDispatch(args)) {
          if (!firstWorker) {
            firstWorker = worker;
            firstTaskId = asOptionalRecord(args[0])?.taskId;
            replies = vi.spyOn(worker, "emit").mockImplementation((event, ...replyArgs) => {
              const reply = asOptionalRecord(replyArgs[0]);
              if (event === "message" && reply?.taskId === firstTaskId) {
                const value =
                  failure !== "wrong-kind"
                    ? {
                        ok: false,
                        error: {
                          kind: "store-summary",
                          details: serializeNativeErrorResponse(
                            new Error("native summary close failed"),
                          ),
                          transientSqlite: false,
                        },
                      }
                    : { ok: true, value: { kind: "history-page" } };
                return EventEmitter.prototype.emit.call(worker, event, { ...reply, value });
              }
              return EventEmitter.prototype.emit.call(worker, event, ...replyArgs);
            });
            if (failure === "retirement-failure") {
              const actualTerminate = worker.terminate.bind(worker);
              terminating = vi
                .spyOn(worker, "terminate")
                .mockRejectedValueOnce(new Error("native worker exit uncertain"))
                .mockRejectedValueOnce(new Error("native worker exit still uncertain"))
                .mockImplementation(async () => {
                  retirementEntered.resolve();
                  await releaseRetirement.promise;
                  return await actualTerminate();
                });
            }
          } else {
            retiredAtSuccessor = firstWorker.threadId === -1;
          }
        }
      };
      const first = readSessionStoreSummaryAsync(scope, workerSummaryOptions);
      const rejected = expect(first).rejects.toThrow(
        failure === "retirement-failure"
          ? "database cleanup did not settle"
          : failure === "native-close-error"
            ? "native summary close failed"
            : "another result",
      );
      const successor = readSessionStoreSummaryAsync(successorScope, workerSummaryOptions);
      try {
        await rejected;
        if (failure === "retirement-failure") {
          let closed = false;
          closing = closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId).then(
            (value) => {
              closed = true;
              return value;
            },
          );
          await Promise.race([
            retirementEntered.promise,
            closing.then(() => {
              throw new Error("Database closed before failed worker retirement was retried");
            }),
          ]);
          expect(closed).toBe(false);
          expect(retiredAtSuccessor).toBe(false);
          expect(firstWorker?.threadId).not.toBe(-1);
          releaseRetirement.resolve();
          await expect(closing).resolves.toBe(true);
        }
        expect((await successor).count).toBe(2);
        expect(retiredAtSuccessor).toBe(true);
        expect(firstWorker?.threadId).toBe(-1);
      } finally {
        releaseRetirement.resolve();
        if (firstWorker && firstWorker.threadId !== -1) {
          await firstWorker.terminate();
        }
        await Promise.allSettled([first, successor, closing]);
        terminating?.mockRestore();
        replies?.mockRestore();
        observed.post = undefined;
      }
    },
  );
});
