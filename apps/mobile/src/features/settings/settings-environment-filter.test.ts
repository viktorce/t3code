import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  selectedIds: null as ReadonlySet<string> | null,
  environments: [] as ReadonlyArray<unknown>,
  projects: [] as ReadonlyArray<unknown>,
}));
// The hook runs without a renderer here: memos compute directly, and the selection is the harness's.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useMemo: <A>(factory: () => A) => factory(),
  useContext: () => ({
    selectedIds: harness.selectedIds,
    selectedProjectKey: null,
    setSelectedIds: () => {},
    selectProject: () => {},
    getSelectedProjectKey: () => null,
  }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: harness.environments }),
}));
vi.mock("../../state/entities", () => ({ useProjects: () => harness.projects }));
vi.mock("../../state/project-grouping", () => ({
  useMobileProjectGroupingSettings: () => ({ sidebarProjectGroupingMode: "repository" }),
}));

import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

const local = EnvironmentId.make("local");
const vps = EnvironmentId.make("vps");
const machine = (environmentId: EnvironmentId, connected: boolean) => ({
  environmentId,
  label: environmentId,
  connection: { phase: connected ? "connected" : "offline" },
  serverConfig: connected ? {} : null,
});
const project = (environmentId: EnvironmentId, name: string) => ({
  id: ProjectId.make(`${name}-${environmentId}`),
  environmentId,
  title: name,
  workspaceRoot: `/work/${name}`,
  repositoryIdentity: {
    canonicalKey: `github.com/example/${name}`,
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: `https://github.com/example/${name}.git`,
    },
  },
});

// regression: the project picker and page counted only connected machines, so a project whose
// checkouts were all offline couldn't be picked, and removing one "everywhere" skipped them
it("keeps the checkouts on selected machines that aren't connected", () => {
  harness.environments = [machine(local, true), machine(vps, false)];
  harness.projects = [project(local, "app"), project(vps, "app"), project(vps, "docs")];
  const membersOf = (filter: ReturnType<typeof useSettingsEnvironmentFilter>, label: string) => {
    const group = filter.selectableProjectGroups.find((entry) => entry.label === label);
    return group ? filter.projectMembersOf(group).map((member) => member.environmentId) : null;
  };

  harness.selectedIds = null;
  const every = useSettingsEnvironmentFilter();
  expect(membersOf(every, "app")).toEqual([local, vps]);
  expect(membersOf(every, "docs")).toEqual([vps]);

  harness.selectedIds = new Set([local]);
  const picked = useSettingsEnvironmentFilter();
  expect(membersOf(picked, "app")).toEqual([local]);
  expect(membersOf(picked, "docs")).toBeNull();
});
