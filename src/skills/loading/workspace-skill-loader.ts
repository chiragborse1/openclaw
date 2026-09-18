import path from "node:path";
import { canonicalizePath } from "../../agents/utils/paths.js";
import {
  getAgentWorkspaceAccess,
  WorkspaceAccessUnavailableError,
} from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { shouldRejectHardlinkedPluginFiles } from "../../plugins/hardlink-policy.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  isSessionSkillEnabled,
  resolveEffectiveAgentSkillFilter,
} from "../discovery/agent-filter.js";
import { normalizeSkillFilter } from "../discovery/filter.js";
import { readWorkspaceSkillStatusFacts } from "../discovery/status-files.js";
import { assertUnambiguousManagedSkillNames } from "../library/command-name.js";
import { loadSkillLibrarySelection } from "../library/selection.js";
import { getSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { mergeRemoteNodeSkillEntries } from "../runtime/remote-skills.js";
import { fingerprintSkillSnapshotConfig } from "../runtime/snapshot-config-fingerprint.js";
import type { SkillEligibilityContext, SkillEntry, SkillSnapshot } from "../types.js";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import {
  hasBinary,
  prepareSkillBinaryProbe,
  resolveBundledAllowlist,
  shouldIncludeSkill,
} from "./config.js";
import { resolveSkillInvocationPolicy, resolveSkillKey } from "./frontmatter.js";
import { loadSingleSkillDirectory } from "./local-loader.js";
import type { Skill } from "./skill-contract.js";
import { resolveSkillEntryMetadata } from "./skill-entry-metadata.js";
import {
  compactSkillPath,
  resolvePluginSkillsDir,
  resolveSkillsUserHomeDir,
} from "./skill-paths.js";
import { resolveSkillDiscoveryLimits } from "./skill-root-discovery.js";
import {
  loadGeneratedPluginSkillRecords,
  loadSkillRootRecords,
  warnInvalidSkill,
  type LoadedSkillRecord,
} from "./skill-root-loader.js";
import { tryRealpath } from "./symlink-targets.js";
import {
  normalizeWorkspaceSkillRoots,
  resolveWorkspaceSkillDirectories,
} from "./workspace-skill-roots.js";
import {
  resolveCustodianSkillAgentId,
  resolveWorkspaceSkillSourcePlan,
  splitSkillSourcePlan,
  type WorkspaceSkillSourcePlan,
  type WorkspaceSkillSourceRequest,
  type WorkspaceSkillSources,
} from "./workspace-skill-sources.js";

const skillsLogger = createSubsystemLogger("skills");
const MAX_SKILL_ENTRY_CACHE_SIZE = 64;
type LocalSkillTiers = { agent: SkillEntry[]; execution: SkillEntry[] };
const skillEntryCache = new Map<string, LocalSkillTiers>();
const reportedSkillCollisions = new Map<string, true>();

type WorkspaceSkillLoadOptions = {
  bundledSkillName?: string;
  executionWorkspaceDir?: string;
  librarySelections?: SkillSnapshot["librarySelections"];
  config?: OpenClawConfig;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
  pluginSkillsDir?: string;
  skillFilter?: string[];
  skillOverrides?: Record<string, boolean>;
  agentId?: string;
  /**
   * "ignore" keeps agentId scoping source discovery (custodian skills) without
   * activating the agent allowlist filter — status/inventory views need the
   * full entry list so excluded skills stay present-but-marked.
   */
  agentSkillFilter?: "apply" | "ignore";
  eligibility?: SkillEligibilityContext;
  workspaceOnly?: boolean;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

// Local-source and workspace-tier collisions share diagnostics and deduplication.
function warnSkillPrecedenceCollision(winner: Skill, loser: Skill, workspaceDir: string): void {
  const collisionKey = JSON.stringify([
    workspaceDir,
    getSkillsSnapshotVersion(workspaceDir),
    winner.name,
    winner.source,
    winner.filePath,
    loser.source,
    loser.filePath,
  ]);
  if (reportedSkillCollisions.has(collisionKey)) {
    return;
  }
  // Lexically distinct workspace roots can reach the same file through a symlink.
  if (canonicalizePath(winner.filePath) === canonicalizePath(loser.filePath)) {
    return;
  }
  reportedSkillCollisions.set(collisionKey, true);
  pruneMapToMaxSize(reportedSkillCollisions, MAX_SKILL_ENTRY_CACHE_SIZE * 4);
  const collisionName = winner.name.slice(0, 128);
  skillsLogger.warn("Skill precedence collision resolved.", {
    skill: collisionName,
    winnerSource: winner.source,
    loserSource: loser.source,
    winnerPath: winner.filePath,
    loserPath: loser.filePath,
    consoleMessage:
      `Skill precedence collision: skill="${collisionName}" ` +
      `winner=${winner.source}:${compactSkillPath(winner.filePath)} ` +
      `loser=${loser.source}:${compactSkillPath(loser.filePath)}`,
  });
}

function filterSkillEntries(
  entries: SkillEntry[],
  config?: OpenClawConfig,
  skillFilter?: string[],
  skillOverrides?: Readonly<Record<string, boolean>>,
  eligibility?: SkillEligibilityContext,
  hasBin?: (bin: string) => boolean,
  platform?: string,
): SkillEntry[] {
  const bundledAllowlist = resolveBundledAllowlist(config);
  assertUnambiguousManagedSkillNames(entries);
  let filtered = entries.filter((entry) =>
    shouldIncludeSkill({ entry, config, bundledAllowlist, eligibility, hasBin, platform }),
  );
  if (skillFilter !== undefined || skillOverrides !== undefined) {
    const normalized = normalizeSkillFilter(skillFilter) ?? [];
    const label = normalized.length > 0 ? normalized.join(", ") : "(none)";
    skillsLogger.debug(`Applying skill filter: ${label}`);
    const resolvedFilter = skillFilter === undefined ? undefined : normalized;
    filtered = filtered.filter((entry) =>
      isSessionSkillEnabled(
        entry.skill.name,
        resolvedFilter,
        skillOverrides,
        resolveSkillKey(entry.skill, entry),
      ),
    );
    skillsLogger.debug(
      `After skill filter: ${filtered.map((entry) => entry.skill.name).join(", ") || "(none)"}`,
    );
  }
  return filtered;
}

function createSkillEntry(record: LoadedSkillRecord): SkillEntry {
  const { skill, frontmatter } = record;
  const invocation = resolveSkillInvocationPolicy(frontmatter);
  const entry: SkillEntry = {
    skill,
    frontmatter,
    metadata: resolveSkillEntryMetadata({ frontmatter, skillDir: skill.baseDir }),
    invocation,
    exposure: {
      includeInRuntimeRegistry: true,
      includeInAvailableSkillsPrompt: !invocation.disableModelInvocation,
      userInvocable: invocation.userInvocable ?? true,
    },
  };
  if (record.syncSourceDir !== undefined) {
    entry.syncSourceDir = record.syncSourceDir;
  }
  if (record.syncDirName !== undefined) {
    entry.syncDirName = record.syncDirName;
  }
  return entry;
}

function mergeSkillRecords<T extends { skill: Skill }>(records: T[], workspaceDir: string): T[] {
  const merged = new Map<string, T>();
  for (const record of records) {
    const replaced = merged.get(record.skill.name);
    if (replaced) {
      warnSkillPrecedenceCollision(record.skill, replaced.skill, workspaceDir);
    }
    merged.set(record.skill.name, record);
  }
  return [...merged.values()].toSorted((a, b) => a.skill.name.localeCompare(b.skill.name, "en"));
}

/** Scan selected roots on their owning host, retaining native precedence and file rules. */
function loadWorkspaceSkillSourceEntries(
  plan: WorkspaceSkillSourcePlan,
  config?: OpenClawConfig,
): SkillEntry[] {
  const grouped = new Map<string, LoadedSkillRecord[]>();
  for (const root of plan.roots) {
    const records = grouped.get(root.tier) ?? [];
    records.push(...loadSkillRootRecords({ ...root, config }));
    grouped.set(root.tier, records);
  }
  const extra = grouped.get("extra") ?? [];
  extra.push(
    ...loadGeneratedPluginSkillRecords({
      pluginSkillsDir: plan.pluginSkillsDir,
      pluginSkillRoots: plan.pluginSkillRoots,
      source: "openclaw-extra",
      limits: resolveSkillDiscoveryLimits(config),
    }),
  );
  grouped.set("extra", extra);
  // Custodian and bundled records share a tier and deterministic collision order.
  grouped
    .get("bundled")
    ?.sort(
      (left, right) =>
        left.skill.name.localeCompare(right.skill.name, "en") ||
        left.skill.source.localeCompare(right.skill.source, "en"),
    );
  return mergeSkillRecords(
    ["extra", "bundled", "workshop", "managed", "personal", "workspace"].flatMap(
      (tier) => grouped.get(tier) ?? [],
    ),
    plan.workspaceDir,
  ).map(createSkillEntry);
}

function loadExecutionSkillEntries(
  workspaceDir: string,
  executionWorkspaceDir: string,
  config?: OpenClawConfig,
): SkillEntry[] {
  return mergeSkillRecords(
    resolveWorkspaceSkillDirectories(executionWorkspaceDir).flatMap((root) =>
      loadSkillRootRecords({ ...root, config }),
    ),
    workspaceDir,
  ).map(createSkillEntry);
}

/** Run on the workspace host using an admitted source plan and native discovery limits. */
export function readWorkspaceSkillSources(
  request: WorkspaceSkillSourceRequest,
): WorkspaceSkillSources {
  const config: OpenClawConfig = {
    skills: {
      limits: request.limits,
      load: { allowSymlinkTargets: request.sourcePlan.allowSymlinkTargets },
    },
  };
  const entries =
    request.bundledSkillName !== undefined
      ? readBundledSkillEntries(request.bundledSkillName, {
          config,
          bundledSkillsDir: request.sourcePlan.bundledSkillsDir,
        })
      : loadWorkspaceSkillSourceEntries(request.sourcePlan, config);
  const executionEntries = request.executionWorkspaceDir
    ? loadExecutionSkillEntries(
        request.sourcePlan.workspaceDir,
        request.executionWorkspaceDir,
        config,
      )
    : [];
  const bins = [
    ...new Set([
      "brew",
      "npm",
      "pnpm",
      "yarn",
      "bun",
      "uv",
      "go",
      ...request.additionalBins,
      ...entries
        .concat(executionEntries)
        .flatMap((entry) =>
          (entry.metadata?.requires?.bins ?? []).concat(entry.metadata?.requires?.anyBins ?? []),
        ),
    ]),
  ]
    .filter(hasBinary)
    .toSorted();
  return {
    entries,
    executionEntries,
    runtime: { platform: process.platform, bins },
    ...(request.status
      ? {
          status: readWorkspaceSkillStatusFacts({
            entries,
            workspaceDir: request.sourcePlan.workspaceDir,
            managedSkillsDir: request.sourcePlan.managedSkillsDir,
            skillCardKey: request.status.skillCardKey,
          }),
        }
      : {}),
  };
}

function loadLocalSkillTiers(
  workspaceDir: string,
  opts?: WorkspaceSkillLoadOptions,
): LocalSkillTiers {
  const workspaceOnly = opts?.workspaceOnly === true;
  const { executionWorkspaceDir } = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: workspaceDir,
    executionWorkspaceDir: opts?.executionWorkspaceDir,
  });
  const custodianAgentId = resolveCustodianSkillAgentId(opts?.config, opts?.agentId, workspaceOnly);
  const osHomeDir = resolveSkillsUserHomeDir();
  const pluginSkillsDir = opts?.pluginSkillsDir ?? resolvePluginSkillsDir();
  // Snapshot versions are the watcher-owned invalidation boundary; cache hits must do no IO.
  const cacheKey = JSON.stringify([
    workspaceDir,
    executionWorkspaceDir,
    workspaceOnly,
    opts?.agentId ? normalizeAgentId(opts.agentId) : undefined,
    custodianAgentId,
    opts?.managedSkillsDir,
    opts?.bundledSkillsDir,
    pluginSkillsDir,
    opts?.config ? fingerprintSkillSnapshotConfig(opts.config) : undefined,
    osHomeDir,
    process.env.OPENCLAW_STATE_DIR,
    getSkillsSnapshotVersion(workspaceDir),
  ]);
  const cachedEntries = skillEntryCache.get(cacheKey);
  if (cachedEntries) {
    return cachedEntries;
  }

  const entries = {
    agent: loadWorkspaceSkillSourceEntries(
      resolveWorkspaceSkillSourcePlan(workspaceDir, opts),
      opts?.config,
    ),
    execution:
      executionWorkspaceDir && !workspaceOnly
        ? loadExecutionSkillEntries(workspaceDir, executionWorkspaceDir, opts?.config)
        : [],
  };
  skillEntryCache.set(cacheKey, entries);
  pruneMapToMaxSize(skillEntryCache, MAX_SKILL_ENTRY_CACHE_SIZE);
  return entries;
}

function loadSkillEntries(workspaceDir: string, opts?: WorkspaceSkillLoadOptions): SkillEntry[] {
  return mergeSkillTiers(workspaceDir, loadLocalSkillTiers(workspaceDir, opts), opts);
}

function mergeSkillTiers(
  workspaceDir: string,
  tiers: LocalSkillTiers,
  opts?: WorkspaceSkillLoadOptions,
  libraryEntries = opts?.librarySelections?.length
    ? loadSkillLibrarySelection(opts.librarySelections)
    : [],
): SkillEntry[] {
  const entries = mergeRemoteNodeSkillEntries(tiers.agent, opts?.eligibility?.nodeSkills);
  if (tiers.execution.length > 0) {
    const agentByName = new Map(entries.map((entry) => [entry.skill.name, entry]));
    // Include node skills in the agent tier before admitting execution-local names.
    // Agent entries also stay first when the prompt budget truncates the catalog.
    for (const entry of tiers.execution) {
      const agentEntry = agentByName.get(entry.skill.name);
      if (agentEntry) {
        warnSkillPrecedenceCollision(agentEntry.skill, entry.skill, workspaceDir);
      } else {
        entries.push(entry);
      }
    }
  }
  entries.push(...libraryEntries);
  return entries;
}

/** Acquire host source tiers before the native node/execution/Library merge. */
export async function prepareWorkspaceSkillEntries(
  workspaceDir: string,
  opts?: WorkspaceSkillLoadOptions & {
    entries?: SkillEntry[];
    status?: { skillCardKey?: string };
  },
  assertCurrent?: () => void,
): Promise<{
  entries: SkillEntry[];
  runtime?: WorkspaceSkillSources["runtime"];
  status?: WorkspaceSkillSources["status"];
}> {
  assertCurrent?.();
  const access = getAgentWorkspaceAccess(workspaceDir);
  if (!access) {
    return {
      entries:
        opts?.bundledSkillName !== undefined
          ? readBundledSkillEntries(opts.bundledSkillName, opts)
          : (opts?.entries ?? loadSkillEntries(workspaceDir, opts)),
    };
  }
  if (!access.loadSkills) {
    throw new WorkspaceAccessUnavailableError("Remote workspace skill discovery is unavailable");
  }
  const bundledOnly = opts?.bundledSkillName !== undefined;
  const libraryEntries =
    !bundledOnly && opts?.librarySelections?.length
      ? loadSkillLibrarySelection(opts.librarySelections)
      : [];
  const { agentWorkspaceDir, executionWorkspaceDir } = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: workspaceDir,
    executionWorkspaceDir: opts?.executionWorkspaceDir,
  });
  const { gatewayRoots, workspacePlan } = splitSkillSourcePlan(
    resolveWorkspaceSkillSourcePlan(
      agentWorkspaceDir,
      bundledOnly ? { ...opts, workspaceOnly: true } : opts,
    ),
  );
  const gatewayEntries = bundledOnly
    ? []
    : gatewayRoots.flatMap((root) =>
        loadSkillRootRecords({ ...root, config: opts?.config }).map((record) => {
          const entry = createSkillEntry(record);
          entry.skill.fileHost = "gateway";
          return entry;
        }),
      );
  const sources = await access.loadSkills({
    sourcePlan: bundledOnly
      ? {
          ...workspacePlan,
          roots: [],
          bundledSkillsDir: opts?.bundledSkillsDir ?? resolveBundledSkillsDir(),
        }
      : workspacePlan,
    bundledSkillName: opts?.bundledSkillName,
    executionWorkspaceDir: opts?.workspaceOnly || bundledOnly ? undefined : executionWorkspaceDir,
    limits: resolveSkillDiscoveryLimits(opts?.config),
    additionalBins: [
      ...new Set(
        libraryEntries
          .concat(gatewayEntries)
          .concat(opts?.entries ?? [])
          .flatMap((entry) =>
            (entry.metadata?.requires?.bins ?? []).concat(entry.metadata?.requires?.anyBins ?? []),
          ),
      ),
    ],
    status: opts?.status,
  });
  assertCurrent?.();
  // A host-supplied source label or path must never authorize Gateway-local reads.
  const onWorkspace = (entry: SkillEntry): SkillEntry => ({
    ...entry,
    skill: { ...entry.skill, fileHost: "workspace" },
  });
  const hostEntries = sources.entries.map(onWorkspace);
  const higherSources = new Set(
    workspacePlan.roots
      .filter((root) => ["managed", "personal", "workspace"].includes(root.tier))
      .map((root) => root.source),
  );
  const agentEntries = gatewayEntries.length
    ? mergeSkillRecords(
        [
          ...hostEntries.filter((entry) => !higherSources.has(entry.skill.source)),
          ...gatewayEntries,
          ...hostEntries.filter((entry) => higherSources.has(entry.skill.source)),
        ],
        agentWorkspaceDir,
      )
    : hostEntries;
  return {
    entries: bundledOnly
      ? hostEntries
      : (opts?.entries ??
        mergeSkillTiers(
          agentWorkspaceDir,
          { agent: agentEntries, execution: sources.executionEntries.map(onWorkspace) },
          opts,
          libraryEntries,
        )),
    runtime: sources.runtime,
    status: sources.status,
  };
}

function resolveEffectiveWorkspaceSkillFilter(opts?: {
  config?: OpenClawConfig;
  agentId?: string;
  agentSkillFilter?: "apply" | "ignore";
  skillFilter?: string[];
}): string[] | undefined {
  if (opts?.skillFilter !== undefined) {
    return normalizeSkillFilter(opts.skillFilter);
  }
  if (opts?.agentSkillFilter === "ignore" || !opts?.config || !opts.agentId) {
    return undefined;
  }
  return resolveEffectiveAgentSkillFilter(opts.config, opts.agentId);
}

export async function resolveWorkspaceSkillPromptEntries(
  workspaceDir: string,
  opts?: {
    executionWorkspaceDir?: string;
    librarySelections?: SkillSnapshot["librarySelections"];
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    entries?: SkillEntry[];
    agentId?: string;
    skillFilter?: string[];
    skillOverrides?: Record<string, boolean>;
    eligibility?: SkillEligibilityContext;
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
    assertCurrent?: () => void;
  },
): Promise<{ eligible: SkillEntry[]; skillFilter: string[] | undefined }> {
  for (;;) {
    opts?.assertCurrent?.();
    const sourceVersion = getSkillsSnapshotVersion(workspaceDir);
    const skillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
    const sources = await prepareWorkspaceSkillEntries(workspaceDir, opts, opts?.assertCurrent);
    const skillEntries = sources.entries;
    const probe = await prepareSkillBinaryProbe(
      skillEntries,
      opts,
      opts?.assertCurrent,
      sources.runtime,
    );
    if (
      probe.needsRetry() ||
      (!opts?.entries && getSkillsSnapshotVersion(workspaceDir) !== sourceVersion)
    ) {
      continue;
    }
    const eligible = filterSkillEntries(
      skillEntries,
      opts?.config,
      skillFilter,
      opts?.skillOverrides,
      opts?.eligibility,
      probe.hasBin,
      sources.runtime?.platform,
    );
    opts?.assertCurrent?.();
    if (probe.needsRetry()) {
      continue;
    }
    return { eligible, skillFilter };
  }
}

function resolveWorkspaceSkillLoad(
  workspaceDir: string,
  opts?: WorkspaceSkillLoadOptions,
  preparedEntries?: SkillEntry[],
) {
  const roots = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: workspaceDir,
    executionWorkspaceDir: opts?.executionWorkspaceDir,
  });
  const entries = preparedEntries ?? loadSkillEntries(roots.agentWorkspaceDir, opts);
  const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  return {
    entries,
    effectiveSkillFilter,
    shouldFilter:
      Boolean(roots.executionWorkspaceDir) ||
      effectiveSkillFilter !== undefined ||
      opts?.skillOverrides !== undefined ||
      opts?.eligibility !== undefined,
  };
}

/** Runtime preparation shares discovery and filtering with synchronous SDK inventory reads. */
export async function prepareWorkspaceSkills(
  workspaceDir: string,
  opts?: WorkspaceSkillLoadOptions,
  assertCurrent?: () => void,
): Promise<SkillEntry[]> {
  for (;;) {
    assertCurrent?.();
    const sourceVersion = getSkillsSnapshotVersion(workspaceDir);
    const sources = await prepareWorkspaceSkillEntries(workspaceDir, opts, assertCurrent);
    const { entries, effectiveSkillFilter, shouldFilter } = resolveWorkspaceSkillLoad(
      workspaceDir,
      opts,
      sources.entries,
    );
    if (!shouldFilter) {
      return entries;
    }
    const probe = await prepareSkillBinaryProbe(entries, opts, assertCurrent, sources.runtime);
    if (probe.needsRetry() || getSkillsSnapshotVersion(workspaceDir) !== sourceVersion) {
      continue;
    }
    const eligible = filterSkillEntries(
      entries,
      opts?.config,
      effectiveSkillFilter,
      opts?.skillOverrides,
      opts?.eligibility,
      probe.hasBin,
      sources.runtime?.platform,
    );
    assertCurrent?.();
    if (probe.needsRetry()) {
      continue;
    }
    return eligible;
  }
}

export function loadWorkspaceSkills(
  workspaceDir: string,
  opts?: WorkspaceSkillLoadOptions,
): SkillEntry[] {
  const { entries, effectiveSkillFilter, shouldFilter } = resolveWorkspaceSkillLoad(
    workspaceDir,
    opts,
  );
  if (!shouldFilter) {
    return entries;
  }
  return filterSkillEntries(
    entries,
    opts?.config,
    effectiveSkillFilter,
    opts?.skillOverrides,
    opts?.eligibility,
  );
}

export function loadVisibleSkills(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    librarySelections?: SkillSnapshot["librarySelections"];
    skillFilter?: string[];
    skillOverrides?: Record<string, boolean>;
    agentId?: string;
    agentSkillFilter?: "apply" | "ignore";
    eligibility?: SkillEligibilityContext;
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
  },
): SkillEntry[] {
  const entries = loadSkillEntries(workspaceDir, opts);
  const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  return filterSkillEntries(
    entries,
    opts?.config,
    effectiveSkillFilter,
    opts?.skillOverrides,
    opts?.eligibility,
  );
}

/** Read a single bundle with the same boundary and file limits as local discovery. */
function readBundledSkillEntries(
  skillName: string,
  opts?: { config?: OpenClawConfig; bundledSkillsDir?: string },
): SkillEntry[] {
  const normalizedName = skillName.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(normalizedName)) {
    return [];
  }
  const bundledSkillsDir = opts?.bundledSkillsDir ?? resolveBundledSkillsDir();
  const rootRealPath = bundledSkillsDir ? tryRealpath(bundledSkillsDir) : undefined;
  if (!rootRealPath) {
    return [];
  }
  const limits = resolveSkillDiscoveryLimits(opts?.config);
  const loaded = loadSingleSkillDirectory({
    skillDir: path.join(rootRealPath, normalizedName),
    source: "openclaw-bundled",
    rootRealPath,
    maxBytes: limits.maxSkillFileBytes,
    rejectHardlinks: shouldRejectHardlinkedPluginFiles({
      origin: "bundled",
      rootDir: rootRealPath,
    }),
    onDiagnostic: (diagnostic) => warnInvalidSkill("openclaw-bundled", diagnostic),
  });
  if (!loaded || loaded.skill.name.trim().toLowerCase() !== normalizedName) {
    return [];
  }
  return [createSkillEntry(loaded)];
}

export function filterWorkspaceSkills(
  entries: SkillEntry[],
  opts?: {
    config?: OpenClawConfig;
    skillFilter?: string[];
    skillOverrides?: Record<string, boolean>;
    eligibility?: SkillEligibilityContext;
  },
): SkillEntry[] {
  return filterSkillEntries(
    entries,
    opts?.config,
    opts?.skillFilter,
    opts?.skillOverrides,
    opts?.eligibility,
  );
}
