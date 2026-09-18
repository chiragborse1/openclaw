import {
  hasCompletionMessageSessionSpawn,
  mergeAcceptedSessionSpawnsForRun,
} from "./accepted-session-spawn.js";
import type { RunEmbeddedAgentParams } from "./embedded-agent-runner/run/params.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import {
  markRequesterTurnYielded,
  settleRequesterAfterSessionSpawns,
} from "./subagents/registry/subagent-registry.js";

/** Transfers the complete logical run's children only after retries have finished. */
export function settleRequesterRun(
  params: Pick<
    RunEmbeddedAgentParams,
    | "sessionKey"
    | "agentId"
    | "runId"
    | "abortSignal"
    | "admittedRunContext"
    | "preparedRunAdmission"
  >,
  result: EmbeddedAgentRunResult,
  assertCurrent: () => void,
): void {
  const instance =
    params.admittedRunContext?.operationalRunInstance ??
    params.preparedRunAdmission?.operationalRunInstance;
  if (instance) {
    const accepted = mergeAcceptedSessionSpawnsForRun(instance, result.acceptedSessionSpawns);
    if (accepted.length > 0) {
      result.acceptedSessionSpawns = accepted;
    }
  }
  if (
    !params.sessionKey ||
    !hasCompletionMessageSessionSpawn(result.acceptedSessionSpawns) ||
    params.abortSignal?.aborted ||
    result.meta.aborted ||
    result.requesterContinuationSettled === true
  ) {
    return;
  }
  const requester = {
    requesterSessionKey: params.sessionKey,
    requesterAgentId: params.agentId,
    requesterTurnRunId: params.runId,
  };
  assertCurrent();
  if (result.meta.continuationPending) {
    // The reply outbox transfers this batch only after its waiting status is
    // delivered. Arming it here would let the final reply overtake that status.
    if (markRequesterTurnYielded(requester) === 0) {
      throw new Error("accepted continuation children were not durably registered");
    }
    return;
  }
  const settled = settleRequesterAfterSessionSpawns({
    ...requester,
    requesterYielded: result.meta.yielded === true,
    acceptedSessionSpawns: result.acceptedSessionSpawns ?? [],
  });
  if (result.meta.yielded) {
    if (!settled) {
      throw new Error("accepted continuation children could not transfer terminal delivery");
    }
    result.requesterContinuationSettled = true;
  }
}
