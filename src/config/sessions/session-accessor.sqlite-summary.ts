import {
  executeSqliteQuerySync,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import {
  hasOpenClawAgentReadOnlySchema,
  withFreshOpenClawAgentDatabaseReadOnly,
} from "../../state/openclaw-agent-db-readonly-open.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly-open.js";
import {
  retainOpenClawAgentDatabaseReadOnly,
  withOpenClawAgentDatabaseReadOnly,
} from "../../state/openclaw-agent-db-readonly.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { resolveStateDir } from "../state-dir.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import type {
  SessionAccessScope,
  SessionEntrySummary,
} from "./session-accessor.sqlite-contract.js";
import { hasSqliteSessionOwnerColumns } from "./session-accessor.sqlite-owner-projection.js";
import { projectSqliteSessionParticipantsBatch } from "./session-accessor.sqlite-participant-projection.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson, selectSessionEntryRows } from "./session-accessor.sqlite-status.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  assertCanonicalSqliteSessionKeysWithAdmission,
  canonicalSessionKeyMigrationRequiredError,
  prepareCanonicalSessionReaderAdmission,
  tryAssertCanonicalSqliteSessionKeysWithAdmission,
  type CanonicalSessionReaderAdmission,
  type CanonicalSessionReaderAdmissionResult,
} from "./session-canonical-key.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "./store-entry.js";

type SummaryCandidate = {
  sessionKey: string;
  entryValid: number | null;
  agent?: SessionStoreSummary;
};

type SessionStoreSummary = { count: number; recent: SessionEntrySummary[] };
type SummaryOptions = { recentLimit: number; agentIds: readonly string[] };
export type SessionStoreSummaryResult = SessionStoreSummary & {
  byAgent: Map<string, SessionStoreSummary>;
};

/** Health/status reader with owned local snapshots and independent worker admission. */
export async function readSessionStoreSummaryAsync(
  scope: Pick<SessionAccessScope, "agentId" | "defaultAgentId" | "env" | "storePath">,
  options: SummaryOptions,
): Promise<SessionStoreSummaryResult> {
  const sourceEnv = scope.env ?? process.env;
  const env = { ...sourceEnv, OPENCLAW_STATE_DIR: resolveStateDir(sourceEnv) };
  const resolved = resolveSqliteScope({ ...scope, env, sessionKey: "" });
  const database = toDatabaseOptions(resolved);
  const storePath = resolveOpenClawAgentSqlitePath(database);
  const capturedOptions = { recentLimit: options.recentLimit, agentIds: [...options.agentIds] };
  if (isIncognitoOpenClawAgentSqlitePath(storePath, database)) {
    const result = withOpenClawAgentDatabaseReadOnly(
      (owned) => readSessionStoreSummaryInDatabase(owned, capturedOptions),
      database,
    );
    return result.found ? result.value.summary : emptySessionStoreSummary(capturedOptions.agentIds);
  }
  const retained = retainOpenClawAgentDatabaseReadOnly(database);
  if (!retained.found) {
    return emptySessionStoreSummary(capturedOptions.agentIds);
  }
  const completion = createDeferredCore();
  const controller = new AbortController();
  let closeWorker: (() => Promise<void> | undefined) | undefined;
  const closeResources = () => {
    const pending = closeWorker?.();
    if (pending) {
      return pending.then(() => retained.close());
    }
    return retained.close();
  };
  let outcome: { ok: true; summary: SessionStoreSummaryResult } | { ok: false; error: unknown };
  let unregister = () => {};
  try {
    unregister = registerOpenClawAgentDatabaseAsyncResource({
      agentId: retained.database.agentId,
      path: retained.database.path,
      revoke: () => {
        controller.abort(new Error("Session summary database read was revoked"));
        retained.claim.release();
      },
      close: async () => {
        await completion.promise;
        await closeResources();
      },
    });
    const admission = prepareCanonicalSessionReaderAdmission(retained.database);
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      retained.claim.assertCurrent();
      admission.assertCurrent();
      if (!hasOpenClawAgentReadOnlySchema(retained.database)) {
        throw new Error("Session summary database schema is no longer current");
      }
    };
    assertCurrent();
    let result = tryReadSessionStoreSummaryInDatabase(
      retained.database,
      capturedOptions,
      admission.input,
    );
    if (result) {
      // Local snapshots remain independent of worker queues; acceptance still checks revocation.
      await Promise.resolve();
    } else {
      const { startSessionStoreSummaryWorkerRead } =
        await import("./session-transcript-worker-runtime.js");
      assertCurrent();
      const work = startSessionStoreSummaryWorkerRead(
        {
          database: { agentId: retained.database.agentId, path: retained.database.path },
          env,
          options: capturedOptions,
          admission: admission.input,
        },
        assertCurrent,
        controller.signal,
      );
      closeWorker = work.close;
      result = await work.result;
    }
    assertCurrent();
    if (result.admission) {
      admission.accept(result.admission);
    }
    outcome = { ok: true, summary: result.summary };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    const pending = closeResources();
    if (pending) {
      await pending;
    }
    unregister();
  } catch (cleanupError) {
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.error, cleanupError],
        "Session summary read failed and database cleanup did not settle",
        { cause: cleanupError },
      );
    }
    throw cleanupError;
  } finally {
    completion.resolve();
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.summary;
}

function emptySessionStoreSummary(agentIds: readonly string[]): SessionStoreSummaryResult {
  return {
    count: 0,
    recent: [],
    byAgent: new Map(agentIds.map((agentId) => [agentId, { count: 0, recent: [] }])),
  };
}

/** Each summary task closes its own native reader before replying. */
export function readSessionStoreSummaryInWorker(
  databaseOptions: OpenClawAgentDatabaseOptions,
  options: SummaryOptions,
  admission: CanonicalSessionReaderAdmission,
): SummaryReadResult {
  const result = withFreshOpenClawAgentDatabaseReadOnly(
    (database) => readSessionStoreSummaryInDatabase(database, options, admission),
    databaseOptions,
  );
  return result.found ? result.value : { summary: emptySessionStoreSummary(options.agentIds) };
}

const LOCAL_SUMMARY_MAX_ROWS = 32;
const LOCAL_SUMMARY_MAX_AGENTS = 32;
const LOCAL_SUMMARY_MAX_PARTICIPANTS = 128;
const LOCAL_SUMMARY_MAX_BYTES = 64 * 1024;
type SummaryReadResult = {
  summary: SessionStoreSummaryResult;
  admission?: CanonicalSessionReaderAdmissionResult;
};

/** Decide and finish on one snapshot; an unproven bound selects the worker before scanning. */
function tryReadSessionStoreSummaryInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
  options: SummaryOptions,
  admission: CanonicalSessionReaderAdmission,
): SummaryReadResult | undefined {
  if (
    database.db.isTransaction ||
    options.agentIds.length > LOCAL_SUMMARY_MAX_AGENTS ||
    !Number.isSafeInteger(options.recentLimit) ||
    options.recentLimit < 0 ||
    options.recentLimit > LOCAL_SUMMARY_MAX_ROWS
  ) {
    return undefined;
  }
  let remainingBytes = LOCAL_SUMMARY_MAX_BYTES;
  for (const agentId of options.agentIds) {
    if (agentId.length > remainingBytes) {
      return undefined;
    }
    remainingBytes -= Buffer.byteLength(agentId);
    if (remainingBytes < 0) {
      return undefined;
    }
  }
  return withSqlitePostCommitPublications(database.db, () =>
    runSqliteDeferredTransactionSync(database.db, () => {
      const admitted = tryAssertCanonicalSqliteSessionKeysWithAdmission(database, admission);
      if (!admitted) {
        return undefined;
      }
      if (!hasSqliteSessionOwnerColumns(database.db)) {
        return undefined;
      }
      const db = getSessionKysely(database.db);
      // Column octet_length reads stored sizes without loading overflow pages or parsing JSON.
      const rows = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_nodes")
          .select((eb) => [
            eb.fn<number>("octet_length", ["session_key"]).as("keyBytes"),
            eb.fn<number>("octet_length", ["entry_json"]).as("entryBytes"),
            eb.fn
              .coalesce(eb.fn<number>("octet_length", ["owner_actor_type"]), eb.val(0))
              .as("ownerTypeBytes"),
            eb.fn
              .coalesce(eb.fn<number>("octet_length", ["owner_actor_id"]), eb.val(0))
              .as("ownerIdBytes"),
            eb.fn
              .coalesce(eb.fn<number>("octet_length", ["owner_assigned_by_type"]), eb.val(0))
              .as("assignerTypeBytes"),
            eb.fn
              .coalesce(eb.fn<number>("octet_length", ["owner_assigned_by_id"]), eb.val(0))
              .as("assignerIdBytes"),
          ])
          .limit(LOCAL_SUMMARY_MAX_ROWS + 1),
      ).rows;
      if (rows.length > LOCAL_SUMMARY_MAX_ROWS) {
        return undefined;
      }
      for (const row of rows) {
        for (const bytes of Object.values(row)) {
          if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > remainingBytes) {
            return undefined;
          }
          remainingBytes -= bytes;
        }
      }
      if (tableExists(database.db, "session_participants")) {
        const participants = executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("session_participants")
            .select((eb) => [
              eb.fn<number>("octet_length", ["session_key"]).as("keyBytes"),
              eb.fn<number>("octet_length", ["identity_namespace"]).as("namespaceBytes"),
              eb.fn<number>("octet_length", ["actor_id"]).as("actorBytes"),
            ])
            .limit(LOCAL_SUMMARY_MAX_PARTICIPANTS + 1),
        ).rows;
        if (participants.length > LOCAL_SUMMARY_MAX_PARTICIPANTS) {
          return undefined;
        }
        for (const row of participants) {
          for (const bytes of Object.values(row)) {
            if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > remainingBytes) {
              return undefined;
            }
            remainingBytes -= bytes;
          }
        }
      }
      return { summary: readSessionStoreSummarySnapshot(database, options), admission: admitted };
    }),
  );
}

function readSessionStoreSummaryInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
  options: SummaryOptions,
  admission?: CanonicalSessionReaderAdmission,
): SummaryReadResult {
  return withSqlitePostCommitPublications(database.db, () =>
    runSqliteDeferredTransactionSync(database.db, () => {
      let admitted: CanonicalSessionReaderAdmissionResult | undefined;
      if (admission) {
        admitted = assertCanonicalSqliteSessionKeysWithAdmission(database, admission);
      } else {
        assertCanonicalSqliteSessionKeysCurrent(database);
      }
      return {
        summary: readSessionStoreSummarySnapshot(database, options),
        ...(admitted ? { admission: admitted } : {}),
      };
    }),
  );
}

/** All execution routes consume this connection-bound inventory and projection kernel. */
function readSessionStoreSummarySnapshot(
  database: OpenClawAgentReadOnlyDatabase,
  options: SummaryOptions,
): SessionStoreSummaryResult {
  const summary = emptySessionStoreSummary(options.agentIds);
  const db = getSessionKysely(database.db);
  // The read transaction keeps count, ordering, and selected payloads on one
  // generation. Existing keys/indexes bound JSON work, not the cold canonical check.
  // Small stores keep their bounded recent payloads; shared stores amortize
  // hydration without retaining every pending row or assuming entry_valid can parse.
  const batchSize = Math.min(
    128,
    Math.max(1, Math.ceil(options.recentLimit) || 1) * Math.max(1, summary.byAgent.size),
  );
  let candidates: SummaryCandidate[] = [];
  const readCandidates = () => {
    if (candidates.length === 0) {
      return;
    }
    const rows = candidates;
    candidates = [];
    const storedRows = new Map(
      executeSqliteQuerySync(
        database.db,
        selectSessionEntryRows(database, "full")
          .select("updated_at")
          .where("session_key", "in", sqliteStringSet(rows.map((row) => row.sessionKey))),
      ).rows.map((row) => [row.session_key, row]),
    );
    const selectedEntries: SessionEntrySummary[] = [];
    for (const { sessionKey, entryValid, agent } of rows) {
      const needsRecent =
        summary.recent.length < options.recentLimit ||
        (agent !== undefined && agent.recent.length < options.recentLimit);
      if (entryValid === 1 && !needsRecent) {
        summary.count += 1;
        if (agent) {
          agent.count += 1;
        }
        continue;
      }
      // Raw updates clear entry_valid. Preserve listing's warm-row semantics:
      // skip unreadable JSON/retained placeholders, but include readable pending rows.
      const stored = storedRows.get(sessionKey);
      if (!stored) {
        continue;
      }
      const entry = parseSessionEntryJson(stored);
      if (!entry) {
        continue;
      }
      summary.count += 1;
      const selected = { sessionKey, entry };
      selectedEntries.push(selected);
      if (summary.recent.length < options.recentLimit) {
        summary.recent.push(selected);
      }
      if (agent) {
        agent.count += 1;
        // The global newest rows may all belong to another agent. Select each
        // requested owner's window in this scan, sharing each parsed payload.
        if (agent.recent.length < options.recentLimit) {
          agent.recent.push(selected);
        }
      }
    }
    if (selectedEntries.length === 0) {
      return;
    }
    const projected = projectSqliteSessionParticipantsBatch(
      database.db,
      new Map(selectedEntries.map(({ sessionKey, entry }) => [sessionKey, entry])),
    );
    for (const { sessionKey, entry } of selectedEntries) {
      Object.assign(entry, projected.get(sessionKey));
      const deliveryCanonicalKey = resolveDeliveryProvenCanonicalSessionKey(sessionKey, entry);
      if (deliveryCanonicalKey !== sessionKey) {
        throw canonicalSessionKeyMigrationRequiredError(
          `non-canonical persisted row resolves to session key ${deliveryCanonicalKey}`,
        );
      }
    }
  };
  for (const row of iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["session_key", "entry_valid"])
      .orderBy("updated_at", "desc")
      .orderBy("session_key", "asc"),
  )) {
    const owner = parseAgentSessionKey(row.session_key)?.agentId;
    if (!owner || isInternalSessionEffectsKey(row.session_key)) {
      continue;
    }
    const agent = summary.byAgent.get(owner);
    if (
      row.entry_valid === 1 &&
      summary.recent.length >= options.recentLimit &&
      (!agent || agent.recent.length >= options.recentLimit)
    ) {
      summary.count += 1;
      if (agent) {
        agent.count += 1;
      }
      continue;
    }
    candidates.push({ sessionKey: row.session_key, entryValid: row.entry_valid, agent });
    if (candidates.length >= batchSize) {
      readCandidates();
    }
  }
  readCandidates();
  return summary;
}
