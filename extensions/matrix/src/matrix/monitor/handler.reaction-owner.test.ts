import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/session-binding-runtime";
import {
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "openclaw/plugin-sdk/system-event-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixReactionEvent,
} from "./handler.test-helpers.js";

beforeEach(() => {
  installMatrixMonitorTestRuntime();
  resetSystemEventsForTest();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});
afterEach(() => {
  resetSystemEventsForTest();
  clearRuntimeConfigSnapshot();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});

describe("Matrix reaction ownership", () => {
  it("keeps a reaction on the runtime-bound global owner's queue", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }, { id: "research" }] },
      channels: { matrix: { dm: { allowFrom: ["*"] } } },
    };
    setRuntimeConfigSnapshot(cfg);
    const binding = {
      bindingId: "reaction-owner",
      targetSessionKey: "global",
      targetKind: "session" as const,
      conversation: { channel: "matrix", accountId: "ops", conversationId: "!room:example.org" },
      status: "active" as const,
      boundAt: 1,
      metadata: { agentId: "research" },
    };
    registerSessionBindingAdapter({
      ...binding.conversation,
      listBySession: () => [binding],
      resolveByConversation: () => binding,
    });
    const { handler, recordInboundSession, runPrepared } = createMatrixHandlerTestHarness({
      cfg,
      client: { getEvent: async () => ({ sender: "@bot:example.org" }) },
      getMemberDisplayName: async () => "sender",
    });

    await handler(
      "!room:example.org",
      createMatrixReactionEvent({ eventId: "$owner-reaction", targetEventId: "$msg1", key: "👍" }),
    );

    expect(peekSystemEventEntries("agent:research:global")).toEqual([
      expect.objectContaining({ text: "Matrix reaction added: 👍 by sender on msg $msg1" }),
    ]);
    expect(peekSystemEventEntries("agent:main:global")).toEqual([]);
    expect(binding.targetSessionKey).toBe("global");
    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(runPrepared).not.toHaveBeenCalled();
  });
});
