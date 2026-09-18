import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { readWorkspaceSkillSources } from "../../skills/loading/workspace-skill-loader.js";
import {
  resolveWorkspaceSkillSourcePlan,
  type WorkspaceSkillSourceRequest,
} from "../../skills/loading/workspace-skill-sources.js";
import { writeSkill } from "../../skills/test-support/e2e-test-helpers.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { skillsHandlers } from "./skills.js";
import { callGatewayHandler } from "./skills.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("reads remote skill status, cards and binary requirements through the workspace binding", async () => {
  const root = tempDirs.make("gateway-remote-skills-");
  const gateway = path.join(root, "gateway");
  const remote = path.join(root, "remote");
  const hostPlatform = process.platform === "linux" ? "darwin" : "linux";
  await writeSkill({
    dir: path.join(gateway, "skills", "stale"),
    name: "stale",
    description: "Stale",
  });
  await writeSkill({
    dir: path.join(remote, "skills", "available"),
    name: "available",
    description: "Remote skill",
    metadata: JSON.stringify({
      openclaw: {
        os: [hostPlatform],
        requires: { bins: ["host-tool"] },
        install: [{ id: "host", kind: "node", package: "host-tool", os: [hostPlatform] }],
      },
    }),
  });
  await writeSkill({
    dir: path.join(remote, "skills", "installer"),
    name: "installer",
    description: "Workspace dependency recipes",
    metadata: JSON.stringify({
      openclaw: {
        install: [
          { id: "brew", kind: "brew", formula: "fixture-tool" },
          { id: "host", kind: "node", package: "host-tool", os: [hostPlatform] },
          { id: "gateway", kind: "node", package: "gateway-tool", os: [process.platform] },
        ],
      },
    }),
  });
  await writeSkill({
    dir: path.join(remote, "skills", "missing"),
    name: "missing",
    description: "Missing dependency",
    metadata: JSON.stringify({ openclaw: { requires: { bins: ["absent-tool"] } } }),
  });
  await fs.writeFile(path.join(remote, "skills", "available", "skill-card.md"), "# Remote card\n");
  const config = {
    plugins: { enabled: false },
    agents: { list: [{ id: "main", workspace: gateway }] },
  };
  const loadSkills = vi.fn(async (request: WorkspaceSkillSourceRequest) => ({
    ...readWorkspaceSkillSources({
      ...request,
      sourcePlan: resolveWorkspaceSkillSourcePlan(remote, { workspaceOnly: true }),
    }),
    runtime: { platform: hostPlatform, bins: ["host-tool", "brew"] },
  }));
  const release = registerAgentWorkspaceAccess(gateway, {
    bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
    loadSkills,
  });
  const call = (method: string, params = {}) =>
    callGatewayHandler(skillsHandlers, method, params, {
      context: { getRuntimeConfig: () => config },
    });
  try {
    const status = await withEnvAsync({ PATH: "" }, () => call("skills.status"));
    expect(status).toMatchObject({
      ok: true,
      response: {
        skills: [
          {
            name: "available",
            eligible: true,
            platformIncompatible: false,
            install: [{ id: "host" }],
            skillCard: { present: true },
          },
          { name: "installer", install: [{ id: "brew" }] },
          { name: "missing", eligible: false, missing: { bins: ["absent-tool"] } },
        ],
      },
    });
    expect(JSON.stringify(status.response)).not.toContain("# Remote card");
    expect(await call("skills.skillCard", { skillKey: "available" })).toMatchObject({
      ok: true,
      response: { skillKey: "available", content: "# Remote card\n" },
    });
    expect(loadSkills).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: { skillCardKey: "available" } }),
    );
    expect(await call("skills.bins")).toMatchObject({
      ok: true,
      response: { bins: ["absent-tool", "host-tool"] },
    });
  } finally {
    release();
  }
});
