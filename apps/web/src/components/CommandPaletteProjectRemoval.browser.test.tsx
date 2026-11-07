import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type AuthSessionState,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import type { Project } from "../types";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;

const state = vi.hoisted(() => ({
  projects: [] as Project[],
  sessions: new Map<string, unknown>(),
  toast: vi.fn(),
  // Whether the server applies a removed project's own cleanup rule, as this version does.
  keepsRule: true,
  // Which of the machine's rule and this project's rule delete worktrees with deleted threads.
  machineDeletes: true,
  projectDeletes: false,
  offline: false,
}));
// Session grants come from the server; the test grants them through these atoms.
vi.mock(import("@t3tools/client-runtime/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createEnvironmentSessionAtoms: ((
      ...args: Parameters<typeof actual.createEnvironmentSessionAtoms>
    ) => ({
      ...actual.createEnvironmentSessionAtoms(...args),
      sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id),
    })) as typeof actual.createEnvironmentSessionAtoms,
  };
});
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: environments() })) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => state.projects) as never,
  useThreadShellsForProjectRefs: () => [],
  useServerConfigs: (() =>
    new Map(
      environments().map((environment) => [environment.environmentId, environment.serverConfig]),
    )) as never,
}));
vi.mock(import("~/state/shell"), async (original) => ({
  ...(await original()),
  liveShellEnvironmentIdsAtom: Atom.make(new Set([EnvironmentId.make("vps")])) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));
// No toaster is mounted in these tests; toasts are read at this seam.
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});

import { appAtomRegistry } from "../rpc/atomRegistry";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { useProjectGroupRemoval } from "../hooks/useProjectGroupUpdate";
import { CommandPaletteProjectRemoval } from "./CommandPaletteProjectRemoval";

const vpsId = EnvironmentId.make("vps");
const settings = () =>
  ({
    ...DEFAULT_SERVER_SETTINGS,
    storageCleanup: {
      ...DEFAULT_SERVER_SETTINGS.storageCleanup,
      worktreeOnDelete: state.machineDeletes,
    },
    projectSettingsOverrides: {
      acme: {
        worktreeCleanup: state.projectDeletes
          ? {
              mode: "custom",
              rules: {
                ...DEFAULT_SERVER_SETTINGS.storageCleanup,
                worktreeOnDelete: true,
              },
            }
          : { mode: "off" },
      },
    },
  }) as never;
const environments = () => [
  {
    environmentId: vpsId,
    label: "vps",
    connection: { phase: state.offline ? "disconnected" : "connected" },
    serverConfig: {
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      settings: settings(),
      environment: {
        platform: { machine: "server" },
        capabilities: { removedProjectCleanupRule: state.keepsRule },
      },
    },
  },
];

const operator: AuthSessionState = {
  authenticated: true,
  scopes: [AuthOrchestrationOperateScope],
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
  },
};

function setup() {
  vi.clearAllMocks();
  state.keepsRule = true;
  state.machineDeletes = true;
  state.projectDeletes = false;
  state.offline = false;
  state.sessions.clear();
  state.sessions.set(
    vpsId,
    Atom.make<SessionResult>(AsyncResult.success(operator)).pipe(Atom.keepAlive),
  );
  state.projects = [
    {
      id: ProjectId.make("acme"),
      environmentId: vpsId,
      title: "Acme",
      workspaceRoot: "/srv/acme",
      repositoryIdentity: null,
      defaultModelSelection: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      scripts: [],
    },
  ];
}

function hostFor(onClose: () => void) {
  const group = buildSidebarProjectSnapshots({
    projects: state.projects,
    settings: DEFAULT_CLIENT_SETTINGS,
    primaryEnvironmentId: vpsId,
    resolveEnvironmentLabel: (id) => id,
  })[0]!;
  return () => (
    <RegistryContext.Provider value={appAtomRegistry}>
      <CommandPaletteProjectRemoval
        group={group}
        locations={new Map()}
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        onClose={onClose}
        onFollowSettingsLink={() => {}}
      />
    </RegistryContext.Provider>
  );
}

// regression: an older server's sweeps can apply either rule, so the one that deletes is shown
it.each([
  ["keeps the removed project's rule", true, true, false, false],
  ["drops it and the machine's rule deletes", false, true, false, true],
  ["drops it and the project's rule deletes", false, false, true, true],
])(
  "shows the worktree rule a server applies when it %s",
  async (_case, keepsRule, machineDeletes, projectDeletes, deletes) => {
    setup();
    state.keepsRule = keepsRule;
    state.machineDeletes = machineDeletes;
    state.projectDeletes = projectDeletes;
    await using _screen = await render(hostFor(() => {})());
    await expect.element(page.getByRole("button", { name: "Remove project" })).toBeVisible();
    const deletion = page.getByText(/Deletes their worktrees/);
    if (deletes) await expect.element(deletion).toBeVisible();
    else await expect.element(deletion).not.toBeInTheDocument();
  },
);

// regression: a machine whose last project went stopped counting as one this connection may change
it("closes once its project is gone, even when that was its machine's last project", async () => {
  setup();
  const onClose = vi.fn();
  const host = hostFor(onClose);
  await using screen = await render(host());
  await expect.element(page.getByRole("button", { name: "Remove project" })).toBeEnabled();

  // Another device removed it, or a removal whose reply a dropped connection lost went through.
  state.projects = [];
  await screen.rerender(host());
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "success", title: '"Acme" was removed' }),
  );
});

// regression: a machine read as refused until its session arrived, and after a failed check
it("calls the removal refused only once a session that refuses it loads", async () => {
  setup();
  const session = Atom.make<SessionResult>(AsyncResult.initial()).pipe(Atom.keepAlive);
  state.sessions.set(vpsId, session);
  const host = hostFor(() => {});
  await using screen = await render(host());
  await expect.element(page.getByText("vps is still loading…")).toBeVisible();

  // A failed check is retried while connected, and says nothing about the grant.
  await act(() =>
    appAtomRegistry.set(
      session,
      AsyncResult.failure(Cause.fail(new Error("Session check failed"))),
    ),
  );
  await expect.element(page.getByText("vps is still loading…")).toBeVisible();
  state.offline = true;
  await screen.rerender(host());
  await expect
    .element(page.getByText("vps isn't connected. Connect it to remove this project."))
    .toBeVisible();

  state.offline = false;
  await act(() => appAtomRegistry.set(session, AsyncResult.success({ ...operator, scopes: [] })));
  await expect
    .element(page.getByText("This connection can't change projects on vps."))
    .toBeVisible();
});

// regression: a machine offline since the app started hid its projects from "Remove a project"
it("hides removal only from a machine whose session refuses it", async () => {
  setup();
  const session = Atom.make<SessionResult>(AsyncResult.initial()).pipe(Atom.keepAlive);
  state.sessions.set(vpsId, session);
  function Probe() {
    const { canRemoveProjectGroup } = useProjectGroupRemoval();
    const members = state.projects.map((project) => ({ ...project, environmentLabel: "vps" }));
    return <span>{canRemoveProjectGroup(members) ? "offered" : "hidden"}</span>;
  }
  await using _screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <Probe />
    </RegistryContext.Provider>,
  );
  await expect.element(page.getByText("offered")).toBeVisible();

  await act(() => appAtomRegistry.set(session, AsyncResult.success({ ...operator, scopes: [] })));
  await expect.element(page.getByText("hidden")).toBeVisible();
});
