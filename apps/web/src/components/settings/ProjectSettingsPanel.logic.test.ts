import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { planProjectRemoval, projectRemovalTarget } from "@t3tools/client-runtime/state/projects";

describe("project removal confirmation", () => {
  const local = {
    id: ProjectId.make("shared-id"),
    environmentId: EnvironmentId.make("local"),
    title: "Repo",
    workspaceRoot: "/work/repo",
    environmentLabel: "Local",
  };
  const remote = {
    ...local,
    environmentId: EnvironmentId.make("remote"),
    environmentLabel: "Remote",
  };

  const parentId = ThreadId.make("parent");
  const listed = { rootThreadId: parentId, parentThreadId: null, relationshipToParent: null };
  const child = { rootThreadId: parentId, parentThreadId: parentId };
  const running = {
    status: "running",
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as const;

  it("limits a checkout's thread count to its listed threads in that environment and project", () => {
    const plan = planProjectRemoval({
      members: [local],
      groupMemberCount: 2,
      hasOtherMembers: false,
      displayName: "Repo",
      threads: [
        {
          environmentId: local.environmentId,
          projectId: local.id,
          lineage: listed,
          runtime: running,
        },
        {
          environmentId: local.environmentId,
          projectId: local.id,
          lineage: { ...child, relationshipToParent: "subagent" },
          runtime: running,
        },
        {
          environmentId: local.environmentId,
          projectId: local.id,
          lineage: { ...child, relationshipToParent: "fork", sideChat: true },
        },
        { environmentId: remote.environmentId, projectId: remote.id, lineage: listed },
      ],
    });
    expect(plan.projectThreads).toHaveLength(3);
    // A running subagent stops with its parent, so only listed threads count as running.
    expect(plan.runningThreadCount).toBe(1);
    expect(plan.confirmationMessage).toBe(
      "Remove checkout \"Repo\" and delete its 1 thread?\nPath: /work/repo\nEnvironment: Local\nThose threads and any archived threads are deleted from T3 Code. Provider sessions are kept.\nStops 1 unfinished thread.\nThe project's other checkouts stay.\nThe project folder stays on disk. Thread worktrees follow your storage cleanup settings.\nThis can't be undone.",
    );
  });

  it("keeps an environment-filtered group scoped to its selected checkout", () => {
    const plan = planProjectRemoval({
      members: [remote],
      groupMemberCount: 1,
      hasOtherMembers: true,
      displayName: "Repo",
      threads: [],
    });
    expect(plan.targetKind).toBe("checkout");
    expect(plan.confirmationMessage).toContain("Environment: Remote");
    expect(plan.confirmationMessage).toContain("The project's other checkouts stay.");
    expect(plan.confirmationMessage).toContain(
      "Any archived threads are deleted from T3 Code. Provider sessions are kept.",
    );
  });

  // regression: #21409 project-wide removal must count every checkout's threads and keep files
  it("states the full group count and preserves files when removing a project everywhere", () => {
    const plan = planProjectRemoval({
      members: [local, remote],
      groupMemberCount: 2,
      hasOtherMembers: false,
      displayName: "Repo",
      threads: [],
    });
    expect(plan.targetKind).toBe("project");
    expect(plan.confirmationMessage).toContain("This removes both checkouts.");
    expect(plan.confirmationMessage).toContain(
      "Project folders stay on disk. Thread worktrees follow your storage cleanup settings.",
    );
  });

  // The removal dialog already names the project, so there it names only the checkout.
  it.each([
    [
      "a lone checkout by its title",
      [{ title: "Repo", workspaceRoot: "/a/repo", machine: "Local" }],
      '"Repo"',
      "the project",
    ],
    [
      "checkouts on different machines by machine",
      [
        { title: "Repo", workspaceRoot: "/a/repo", machine: "Local" },
        { title: "Repo", workspaceRoot: "/a/repo", machine: "remote" },
      ],
      '"Repo" on Local',
      "the checkout on Local",
    ],
    [
      "checkouts on one machine by folder",
      [
        { title: "Repo", workspaceRoot: "/a/repo", machine: "Local" },
        { title: "Repo", workspaceRoot: "/b/fork", machine: "Local" },
      ],
      '"Repo" (repo) on Local',
      "the repo checkout on Local",
    ],
    [
      "checkouts whose folders share a name by path",
      [
        { title: "Repo", workspaceRoot: "/a/repo", machine: "Local" },
        { title: "Repo", workspaceRoot: "/b/repo", machine: "Local" },
      ],
      '"Repo" (/a/repo) on Local',
      "the /a/repo checkout on Local",
    ],
  ])("names %s when its removal fails", (_case, members, named, inDialog) => {
    const machineOf = (member: (typeof members)[number]) => member.machine;
    expect(projectRemovalTarget(members[0]!, members, machineOf)).toBe(named);
    expect(projectRemovalTarget(members[0]!, members, machineOf, { projectNamed: true })).toBe(
      inDialog,
    );
  });
});
