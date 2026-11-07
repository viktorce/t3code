import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { planProjectRemoval } from "@t3tools/client-runtime/state/projects";

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
  const run = (status: "running" | "queued" | "waiting" | "completed" | "cancelled") => ({
    runId: RunId.make(`run-${status}`),
    status,
    requestedAt: null,
    startedAt: null,
    completedAt: null,
    assistantMessageId: null,
  });
  const activeRuntime = {
    status: "running",
    activeRunId: RunId.make("run-older"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as const;

  it("counts a checkout's listed threads and every running agent in that environment and project", () => {
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
          latestRun: run("completed"),
          runtime: null,
        },
        {
          environmentId: local.environmentId,
          projectId: local.id,
          lineage: { ...child, relationshipToParent: "subagent" },
          latestRun: run("running"),
          runtime: null,
        },
        {
          environmentId: local.environmentId,
          projectId: local.id,
          lineage: { ...child, relationshipToParent: "fork", sideChat: true },
          latestRun: run("queued"),
          runtime: null,
        },
        // An older run still works after the newer queued one was cancelled.
        {
          environmentId: local.environmentId,
          projectId: local.id,
          lineage: listed,
          latestRun: run("cancelled"),
          runtime: activeRuntime,
        },
        {
          environmentId: remote.environmentId,
          projectId: remote.id,
          lineage: listed,
          latestRun: run("waiting"),
          runtime: activeRuntime,
        },
      ],
    });
    expect(plan.projectThreads).toHaveLength(4);
    expect(plan.runningThreadCount).toBe(3);
    expect(plan.confirmationMessage).toBe(
      'Remove checkout "Repo" and delete its 2 threads?\nPath: /work/repo\nEnvironment: Local\nThose threads and any archived threads are deleted from T3 Code. Provider session history is kept.\n3 running agents will stop.\nOther entries in this grouped project are unaffected.\nThis action cannot be undone.',
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
    expect(plan.runningThreadCount).toBe(0);
    expect(plan.confirmationMessage).toContain("Environment: Remote");
    expect(plan.confirmationMessage).toContain(
      "Other entries in this grouped project are unaffected.",
    );
    expect(plan.confirmationMessage).toContain(
      "Any archived threads are deleted from T3 Code. Provider session history is kept.",
    );
    expect(plan.confirmationMessage).not.toContain("will stop");
  });

  // regression: #21409 project-wide removal must count every checkout's threads and keep files
  it("states the full group count and preserves files when removing a project everywhere", () => {
    const stale = { ...local, id: ProjectId.make("stale-id") };
    const plan = planProjectRemoval({
      members: [local, remote],
      registrations: [local, stale, remote],
      groupMemberCount: 2,
      hasOtherMembers: false,
      displayName: "Repo",
      threads: [local, stale, remote].map((project) => ({
        environmentId: project.environmentId,
        projectId: project.id,
        lineage: listed,
        latestRun: null,
        runtime: null,
      })),
    });
    expect(plan.targetKind).toBe("project");
    expect(plan.threadCount).toBe(3);
    expect(plan.confirmationMessage).toContain("This removes 2 grouped project entries.");
    expect(plan.confirmationMessage).toContain(
      "This removes only the project entries, not the files on disk.",
    );
  });
});
