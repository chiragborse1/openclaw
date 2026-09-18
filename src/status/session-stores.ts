import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readSessionStoreSummaryAsync } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.js";
import type { listGatewayAgentsBasic } from "../gateway/agent-list.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";

export const STATUS_RECENT_SESSION_LIMIT = 10;
const SESSION_STORE_READ_SLICE_MS = 8;
type StoreSummary = Awaited<ReturnType<typeof readSessionStoreSummaryAsync>>;
export type StatusSessionStores = Awaited<
  ReturnType<
    typeof readStatusSessionStores<ReturnType<typeof listGatewayAgentsBasic>["agents"][number]>
  >
>;

/** One collection owns each physical store's bounded snapshot, including its agent windows. */
export async function createStatusSessionStoreReader(
  storeTemplate: string | undefined,
  agentIds: readonly (string | undefined)[],
  recentLimit: number,
  readSummary: typeof readSessionStoreSummaryAsync = readSessionStoreSummaryAsync,
) {
  let sliceStartedAt = performance.now();
  const capturedAgentIds = [...agentIds];
  const agentsByPath = new Map<string, string[]>();
  const targets = new Map<string | undefined, { path: string; agentIds: string[] }>();
  for (const agentId of capturedAgentIds) {
    const storePath = resolveSessionStorePathCore(storeTemplate, { agentId });
    const path = resolveSqliteTargetFromSessionStorePath(storePath, { agentId }).path;
    let storeAgentIds = agentsByPath.get(path);
    if (!storeAgentIds) {
      storeAgentIds = [];
      agentsByPath.set(path, storeAgentIds);
    }
    if (agentId) {
      storeAgentIds.push(agentId);
    }
    targets.set(agentId, { path, agentIds: storeAgentIds });
    if (performance.now() - sliceStartedAt >= SESSION_STORE_READ_SLICE_MS) {
      await yieldToEventLoop();
      sliceStartedAt = performance.now();
    }
  }
  const stores = new Map<string, Promise<StoreSummary>>();
  return {
    stores,
    async read(agentId?: string) {
      const target = expectDefined(targets.get(agentId), "prepared session store target");
      const { path } = target;
      if (agentId && readAgentDatabaseAdmissionRefusal(agentId)) {
        return { path, count: 0, recent: [] };
      }
      let store = stores.get(path);
      if (!store) {
        // Earlier stores can await; keep this collection's resolved physical target fixed.
        store = readSummary(
          { ...(agentId ? { agentId } : {}), storePath: path },
          { agentIds: target.agentIds, recentLimit },
        );
        stores.set(path, store);
        await store;
        // Transactions finish before yielding. Cheap reads share a slice so competing
        // background work cannot add a full event-loop turn to every physical store.
        if (performance.now() - sliceStartedAt >= SESSION_STORE_READ_SLICE_MS) {
          await yieldToEventLoop();
          sliceStartedAt = performance.now();
        }
      }
      const resolved = await store;
      const summary = agentId ? resolved.byAgent.get(agentId) : resolved;
      return { path, count: summary?.count ?? 0, recent: summary?.recent ?? [] };
    },
  };
}

/** Reads each physical store once, retaining retired agent namespaces in the aggregate. */
export async function readStatusSessionStores<Agent extends { id: string; name?: string }>(
  cfg: OpenClawConfig,
  agents: readonly Agent[],
  recentLimit: number,
) {
  const reader = await createStatusSessionStoreReader(
    cfg.session?.store,
    agents.map((agent) => agent.id),
    recentLimit,
  );
  const byAgent = [];
  for (const agent of agents) {
    byAgent.push({
      agent,
      ...(await reader.read(agent.id)),
    });
  }
  const stores = await Promise.all(reader.stores.values());
  return {
    paths: [...reader.stores.keys()],
    count: stores.reduce((count, store) => count + store.count, 0),
    recent: stores.flatMap((store) => store.recent),
    byAgent,
  };
}
