import { vi } from "vitest";
import type { renderUpdates } from "./updates.ts";

export type UpdatesViewProps = Parameters<typeof renderUpdates>[0];

export function createUpdatesProps(overrides: Partial<UpdatesViewProps> = {}): UpdatesViewProps {
  return {
    configObject: { update: { channel: "stable", auto: { enabled: false } } },
    gatewayVersion: "2026.8.1",
    controlUiCommit: "0123456789abcdef0123456789abcdef01234567",
    controlUiCommitAt: "1970-01-01T00:00:00.000Z",
    controlUiBuiltAt: "1970-01-01T00:00:00.000Z",
    schedule: {
      channel: "stable",
      autoEnabled: false,
      install: { kind: "package" },
      target: { kind: "package", version: "2026.8.2" },
    },
    heldUpdateCampaignId: null,
    updateAvailable: {
      currentVersion: "2026.8.1",
      latestVersion: "2026.8.2",
      channel: "stable",
    },
    statusBanner: null,
    statusCheckBanner: null,
    recordedUpdateAttempt: null,
    run: null,
    connected: true,
    configBusy: false,
    canAdmin: true,
    canUpdate: true,
    canCheckStatus: true,
    canHoldUpdate: true,
    canReport: true,
    updateBusy: false,
    statusChecking: false,
    reportableUpdateFailureId: null,
    updateFailureReportBusy: false,
    updateFailureReportNotice: null,
    nowMs: 1_000,
    onChannelChange: vi.fn(),
    onUpdateChecksChange: vi.fn(),
    onAutomaticUpdatesChange: vi.fn(),
    onUpdateNow: vi.fn(),
    onHoldUpdate: vi.fn(async () => true),
    onCheckStatus: vi.fn(async () => true),
    onReportFailure: vi.fn(async () => undefined),
    ...overrides,
  };
}
