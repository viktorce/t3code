import { RegistryContext } from "@effect/atom-react";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import type {
  DeleteProjectInput,
  UpdateProjectInput,
} from "@t3tools/client-runtime/state/projects";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProjectMutationError,
  ProviderInstanceId,
  ThreadId,
  type AuthEnvironmentScope,
  type AuthSessionState,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render, type Screen } from "../../../test/render";
import type { Project } from "../../types";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
const state = vi.hoisted(() => ({
  sessions: new Map<EnvironmentId, Atom.Writable<SessionResult>>(),
  // Machines whose connection dropped; their session grant outlives the connection.
  offline: new Set<EnvironmentId>(),
  // Machines not reached since the app started, so nothing about their server is known.
  neverConnected: new Set<EnvironmentId>(),
  // Machines whose threads are live; the shell mock below sets it.
  liveShell: null as unknown as Atom.Writable<ReadonlySet<EnvironmentId>>,
  projects: [] as Project[],
  // The mock's list is a plain array; bumping this re-renders its readers, as a live list change does.
  projectsChanged: null as unknown as Atom.Writable<number>,
  update:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: UpdateProjectInput;
      }) => Promise<AsyncResult.Success<void>>
    >(),
  delete:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: DeleteProjectInput;
      }) => Promise<AsyncResult.Success<void>>
    >(),
  confirm: vi.fn<(message: string) => Promise<boolean>>(),
  // Thread shells as of the moment they are read.
  threads: [] as EnvironmentThreadShell[],
  releaseUploads: vi.fn(),
  clearDraft: vi.fn(),
  toast: vi.fn(),
}));

// Session grants come from the server; each test drives them through these atoms.
vi.mock(import("@t3tools/client-runtime/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createEnvironmentSessionAtoms: ((
      ...args: Parameters<typeof actual.createEnvironmentSessionAtoms>
    ) => ({
      ...actual.createEnvironmentSessionAtoms(...args),
      sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id)!,
    })) as typeof actual.createEnvironmentSessionAtoms,
  };
});
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: environments.map(withConnection) })) as never,
  readEnvironment: ((id: EnvironmentId) => {
    const environment = environments.find((entry) => entry.environmentId === id);
    return environment ? withConnection(environment) : null;
  }) as never,
  usePrimaryEnvironmentId: () => primaryId,
}));
// A machine's threads go live after its settings load; tests drive that through this atom.
vi.mock(import("~/state/shell"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  state.liveShell = Atom.make<ReadonlySet<EnvironmentId>>(new Set<EnvironmentId>()).pipe(
    Atom.keepAlive,
  );
  return { ...(await original()), liveShellEnvironmentIdsAtom: state.liveShell };
});
vi.mock(import("~/state/entities"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { useAtomValue } = await import("@effect/atom-react");
  state.projectsChanged = Atom.make(0).pipe(Atom.keepAlive);
  return {
    ...(await original()),
    useProjects: (() => {
      useAtomValue(state.projectsChanged);
      return state.projects;
    }) as never,
    readProject: ((ref: { environmentId: EnvironmentId; projectId: ProjectId }) =>
      state.projects.find(
        (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
      ) ?? null) as never,
    useThreadShells: () => [],
    readThreadShells: (() => state.threads) as never,
    useServerConfigs: (() =>
      new Map(
        environments
          .filter((environment) => !state.neverConnected.has(environment.environmentId))
          .map((environment) => [environment.environmentId, environment.serverConfig]),
      )) as never,
    waitForProjectRemoval: async () => true,
  };
});
vi.mock(import("~/state/projects"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    projectEnvironment: {
      ...actual.projectEnvironment,
      update: "update",
      delete: "delete",
    } as unknown as typeof actual.projectEnvironment,
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: "update" | "delete") => state[command]) as never,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS) as never,
}));
vi.mock(import("~/localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => ({ dialogs: { confirm: state.confirm } })) as never,
}));
vi.mock(import("~/lib/composerDraftUploads"), async (original) => ({
  ...(await original()),
  releaseProjectDraftUploads: state.releaseUploads,
}));
// No toaster is mounted in these tests; the guard's error toast is read at this seam.
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});
// These sections have separate data sources and their own tests.
vi.mock(import("./ProjectDefaultsSettings"), async (original) => ({
  ...(await original()),
  ProjectDefaultsSettings: (() => null) as never,
}));
vi.mock(import("./ProjectActionsSettings"), async (original) => ({
  ...(await original()),
  ProjectActionsSettings: (() => null) as never,
}));

vi.mock(import("../files/projectFilesQueryState"), async (original) => ({
  ...(await original()),
  getProjectFileQueryAtom: () => missingProjectFile,
}));

import { useComposerDraftStore } from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { ProjectsSettings } from "./ProjectsSettings";
import { SettingsScopeProvider } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { validateSettingsScopeSearch, type SettingsScopeSearch } from "./settingsScope";
import { retainSettingsScope, validateSettingsRouteSearch } from "./settingsScopeNavigation";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
const instanceId = ProviderInstanceId.make("codex");
const environments = [primaryId, remoteId].map((environmentId) => ({
  environmentId,
  label: environmentId,
  connection: { phase: "connected" },
  serverConfig: {
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    settings: DEFAULT_SERVER_SETTINGS,
    environment: { platform: { machine: "server" }, capabilities: { projectOrganization: true } },
  },
}));
function withConnection<T extends { readonly environmentId: EnvironmentId }>(environment: T) {
  if (state.neverConnected.has(environment.environmentId)) {
    return { ...environment, connection: { phase: "disconnected" }, serverConfig: null };
  }
  return state.offline.has(environment.environmentId)
    ? { ...environment, connection: { phase: "disconnected" } }
    : environment;
}
const session = (scopes: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState => ({
  authenticated: true,
  scopes,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
  },
});
const writable = () => AsyncResult.success(session([AuthOrchestrationOperateScope]));
const missingProjectFile = Atom.make(AsyncResult.initial<never, never>());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function setup() {
  vi.clearAllMocks();
  state.sessions.clear();
  state.offline.clear();
  state.neverConnected.clear();
  state.threads = [];
  appAtomRegistry.set(state.liveShell, new Set([primaryId, remoteId]));
  for (const id of [primaryId, remoteId])
    state.sessions.set(id, Atom.make<SessionResult>(writable()).pipe(Atom.keepAlive));
  state.projects = [primaryId, remoteId].map((environmentId) => ({
    id: ProjectId.make(`project-${environmentId}`),
    environmentId,
    title: "Shared repo",
    workspaceRoot: `/work/${environmentId}`,
    repositoryIdentity: {
      canonicalKey: "github.com/example/shared-repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/shared-repo.git",
      },
    },
    defaultModelSelection: { instanceId, model: "gpt-5-codex" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  }));
  state.update.mockImplementation(async ({ environmentId, input }) => {
    const { projectId, ...updates } = input;
    const patch = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined),
    ) as Partial<Project>;
    state.projects = state.projects.map((project) =>
      project.environmentId === environmentId && project.id === projectId
        ? { ...project, ...patch }
        : project,
    );
    return AsyncResult.success(undefined);
  });
  state.delete.mockResolvedValue(AsyncResult.success(undefined));
  state.confirm.mockResolvedValue(true);
  useComposerDraftStore.setState({ clearProjectDraftThreadId: state.clearDraft });
}

function projectKey(workspaceRoot?: string) {
  const groups = buildSidebarProjectSnapshots({
    projects: state.projects,
    settings: DEFAULT_CLIENT_SETTINGS,
    primaryEnvironmentId: primaryId,
    resolveEnvironmentLabel: (id) => id,
  });
  return (
    workspaceRoot === undefined
      ? groups[0]!
      : groups.find((group) =>
          group.memberProjects.some((member) => member.workspaceRoot === workspaceRoot),
        )!
  ).projectKey;
}

async function mountPanel(search: Omit<SettingsScopeSearch, "project"> = {}) {
  const key = projectKey();
  const rootRoute = createRootRoute();
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "settings",
    validateSearch: validateSettingsRouteSearch,
    search: { middlewares: [retainSettingsScope] },
  });
  const projectsRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: "projects",
    component: () => (
      <ProjectSettingsPanel
        projectKey={key}
        environmentId={search.machine ? EnvironmentId.make(search.machine) : null}
        checkoutKey={search.checkout ?? null}
      />
    ),
  });
  const query = new URLSearchParams({ project: key });
  for (const [name, value] of Object.entries(search)) {
    if (value !== undefined) query.set(name, value);
  }
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute.addChildren([projectsRoute])]),
    history: createMemoryHistory({ initialEntries: [`/settings/projects?${query}`] }),
  });
  await router.load();
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    // The panel's own route tree validates settings search params, which the default router lacks.
    await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <RouterProvider router={router} />
      </RegistryContext.Provider>,
      { router: false },
    ),
  );
  await vi.waitFor(() => expect(nameInput(screen)).not.toBeNull());
  stack.move();
  return { ...screen, router };
}

type SettingsScreen = Awaited<ReturnType<typeof mountSettings>>;

async function mountSettings(search: SettingsScopeSearch) {
  const searchParams = new URLSearchParams(
    Object.entries(search).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
  );
  const route = createRootRoute({
    validateSearch: validateSettingsScopeSearch,
    component: () => (
      <SettingsScopeProvider
        search={route.useSearch()}
        onChange={(next) => void router.navigate({ to: "/settings/projects", search: () => next })}
      >
        <ProjectsSettings />
      </SettingsScopeProvider>
    ),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({
      initialEntries: [`/settings/projects?${searchParams.toString()}`],
    }),
  });
  await router.load();
  // The settings route tree above validates scope search params, which the default router lacks.
  const screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <RouterProvider router={router} />
    </RegistryContext.Provider>,
    { router: false },
  );
  return { ...screen, router };
}

const nameInput = (screen: Screen) =>
  screen.container.querySelector<HTMLInputElement>('[aria-label="Project name"]')!;
const removeCheckout = (screen: Screen, root: string) =>
  screen.container.querySelector<HTMLButtonElement>(`[aria-label="Remove checkout ${root}"]`)!;
const removeAll = (screen: Screen) =>
  [...screen.container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Remove both checkouts"),
  )!;

// The live list re-renders its readers as projects come, go, or change.
async function setProjects(projects: Project[]) {
  state.projects = projects;
  await act(async () =>
    appAtomRegistry.set(state.projectsChanged, appAtomRegistry.get(state.projectsChanged) + 1),
  );
}

// A removal commits, then the live list drops that checkout.
const dropCheckout = (workspaceRoot: string) =>
  setProjects(state.projects.filter((project) => project.workspaceRoot !== workspaceRoot));

const addCheckout = (project: Project) => setProjects([...state.projects, project]);

async function grant(id: EnvironmentId, result: SessionResult) {
  await act(async () => appAtomRegistry.set(state.sessions.get(id)!, result));
}

async function rename(screen: Screen, title: string) {
  await userEvent.fill(nameInput(screen), title);
  await userEvent.keyboard("{Enter}");
}

describe("project organization", () => {
  it("archives the checkout on every machine while one machine is picked", async () => {
    setup();
    await using _screen = await mountPanel({ machine: primaryId });
    await userEvent.click(page.getByRole("button", { name: "Archive" }));
    await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
    expect(
      state.update.mock.calls.map(([request]) => [request.environmentId, request.input.archived]),
    ).toEqual([
      [primaryId, true],
      [remoteId, true],
    ]);
  });

  it.each([
    [
      "remote refuses this connection",
      () => grant(remoteId, AsyncResult.success(session([]))),
      "This connection can't change projects on remote.",
    ],
    // The page's note covers the picked machine only, so it can't say this.
    [
      "remote is offline while primary loads",
      () => {
        state.offline.add(remoteId);
        return grant(primaryId, AsyncResult.initial());
      },
      "Connect remote to change this project.",
    ],
    // Whether its server can pin is unknown, so the rows wait rather than hide.
    [
      "remote hasn't connected since the app started",
      () => {
        state.neverConnected.add(remoteId);
        return grant(remoteId, AsyncResult.initial());
      },
      "Connect remote to change this project.",
    ],
  ])(
    "says why Pin and Archive wait while one machine is picked: %s",
    async (_case, wait, reason) => {
      setup();
      await wait();
      await using _screen = await mountPanel({ machine: primaryId });
      await expect.element(page.getByRole("button", { name: "Archive" })).toBeDisabled();
      await expect.element(page.getByRole("switch", { name: "Pin project" })).toBeDisabled();
      expect(page.getByText(reason, { exact: true }).elements()).toHaveLength(2);
    },
  );
});

describe("project settings permissions", () => {
  it("disables shared edits when any member lacks project access", async () => {
    setup();
    await grant(remoteId, AsyncResult.success(session([AuthSettingsWriteScope])));
    await using screen = await mountPanel();

    expect(nameInput(screen).disabled).toBe(true);
    expect(removeAll(screen).disabled).toBe(true);
    expect(screen.container.textContent).toContain(
      "This connection can't change projects on remote.",
    );
    expect(state.update).not.toHaveBeenCalled();
  });

  it("renames every member when all have project access without settings access", async () => {
    setup();
    await using screen = await mountPanel();
    await rename(screen, "Renamed");
    expect(state.update.mock.calls.map(([request]) => request.environmentId)).toEqual([
      primaryId,
      remoteId,
    ]);
    expect(nameInput(screen).value).toBe("Renamed");
  });

  it.each([
    [
      "its grant is revoked",
      () => grant(remoteId, AsyncResult.success(session([]))),
      "This connection can't change projects on remote.",
    ],
    // regression: a session check that failed and was being retried read as a refusal
    [
      "its session check fails",
      () =>
        grant(
          remoteId,
          AsyncResult.failure(Cause.fail(new Error("Session check failed"))) as SessionResult,
        ),
      "remote is still loading. Try again in a moment.",
    ],
    // regression: only the grant was checked between writes, so the next one went to a dropped machine
    [
      "its machine drops",
      () => {
        state.offline.add(remoteId);
        return grant(remoteId, writable());
      },
      "Connect remote and try again.",
    ],
  ])(
    "stops before the next member if %s during an earlier update",
    async (_case, change, description) => {
      setup();
      const firstUpdate = deferred<AsyncResult.Success<void>>();
      state.update.mockReturnValueOnce(firstUpdate.promise);
      await using screen = await mountPanel();
      await rename(screen, "Renamed");
      expect(state.update).toHaveBeenCalledOnce();

      await change();
      await act(async () => {
        firstUpdate.resolve(AsyncResult.success(undefined));
        await firstUpdate.promise;
      });
      await vi.waitFor(() =>
        expect(state.toast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            title: "Failed to rename project",
            description,
          }),
        ),
      );
      expect(state.toast).toHaveBeenCalledOnce();
      expect(state.update).toHaveBeenCalledOnce();
      expect(state.update.mock.calls[0]![0].environmentId).toBe(primaryId);
    },
  );

  it("disables removal for a checkout whose project grant is missing", async () => {
    setup();
    await grant(remoteId, AsyncResult.success(session([])));
    await using screen = await mountPanel();
    expect(removeCheckout(screen, "/work/remote").disabled).toBe(true);
    expect(removeCheckout(screen, "/work/primary").disabled).toBe(false);
    // Its row says why, and so do the Danger row and the page's note, which cover it too.
    const reason = page.getByText("This connection can't change projects on remote.");
    await expect.element(reason.first()).toBeVisible();
    expect(reason.elements()).toHaveLength(3);
  });

  it("removes a writable checkout while removal of the mixed group stays denied", async () => {
    setup();
    await grant(remoteId, AsyncResult.success(session([])));
    await using screen = await mountPanel();
    const initialHref = screen.router.state.location.href;
    expect(removeAll(screen).disabled).toBe(true);

    await userEvent.click(removeCheckout(screen, "/work/primary"));
    await vi.waitFor(() => expect(state.delete).toHaveBeenCalledOnce());
    expect(state.delete).toHaveBeenCalledWith({
      environmentId: primaryId,
      input: { projectId: state.projects[0]!.id, force: true },
    });
    await vi.waitFor(() => expect(state.releaseUploads).toHaveBeenCalledOnce());
    expect(state.clearDraft).toHaveBeenCalledOnce();
    expect(screen.router.state.location.href).toBe(initialHref);
  });

  it("reports a removal the connection interrupted instead of failing silently", async () => {
    setup();
    state.delete.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()) as never);
    await using screen = await mountPanel();

    await userEvent.click(removeCheckout(screen, "/work/primary"));
    await vi.waitFor(() =>
      expect(state.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: 'Couldn\'t confirm "Shared repo" was removed',
        }),
      ),
    );
    expect(state.releaseUploads).not.toHaveBeenCalled();
    expect(state.clearDraft).not.toHaveBeenCalled();
  });

  it.each([
    [
      "its grant is revoked",
      () => grant(remoteId, AsyncResult.success(session([]))),
      "This connection can't change projects on remote. 1 other checkout was already removed.",
    ],
    // regression: a session check that failed and was being retried read as a refusal
    [
      "its session check fails",
      () =>
        grant(
          remoteId,
          AsyncResult.failure(Cause.fail(new Error("Session check failed"))) as SessionResult,
        ),
      "remote is still loading. 1 other checkout was already removed. Try again in a moment.",
    ],
    [
      "its machine drops",
      () => {
        state.offline.add(remoteId);
      },
      "remote isn't connected. 1 other checkout was already removed. Connect remote and try again.",
    ],
  ])(
    "says what was already removed when a later checkout's machine changes mid-removal: %s",
    async (_case, change, description) => {
      setup();
      const firstDelete = deferred<AsyncResult.Success<void>>();
      state.delete.mockReturnValueOnce(firstDelete.promise);
      await using screen = await mountPanel();
      await userEvent.click(removeAll(screen));
      await vi.waitFor(() => expect(state.delete).toHaveBeenCalledOnce());
      // While it runs, it's announced, and no other removal can start.
      expect(page.getByRole("status").element()).toHaveTextContent("Removing…");
      expect(removeCheckout(screen, "/work/primary")).toHaveAttribute("aria-disabled", "true");

      await change();
      await act(async () => {
        firstDelete.resolve(AsyncResult.success(undefined));
        await firstDelete.promise;
      });
      await vi.waitFor(() =>
        expect(state.toast).toHaveBeenCalledWith(
          expect.objectContaining({ type: "error", description }),
        ),
      );
      expect(state.delete).toHaveBeenCalledOnce();
      expect(removeCheckout(screen, "/work/primary")).not.toHaveAttribute("aria-disabled");
    },
  );

  it.each([
    ["this client's list has dropped it", true, new Error("invalid_command")],
    [
      "the server says so while this client's list still shows it",
      false,
      new ProjectMutationError({
        commandId: CommandId.make("command:already-removed"),
        message: "Failed to mutate project.",
        reason: "not-found",
      }),
    ],
  ] as const)(
    "treats a checkout already removed elsewhere as removed when %s",
    async (_case, listCaughtUp, error) => {
      setup();
      state.delete.mockImplementationOnce(async ({ environmentId, input }) => {
        if (listCaughtUp) {
          state.projects = state.projects.filter(
            (project) =>
              !(project.environmentId === environmentId && project.id === input.projectId),
          );
        }
        return AsyncResult.failure(Cause.fail(error)) as never;
      });
      await using screen = await mountPanel();

      await userEvent.click(removeCheckout(screen, "/work/primary"));
      await vi.waitFor(() => expect(state.releaseUploads).toHaveBeenCalledOnce());
      expect(state.toast).not.toHaveBeenCalled();
    },
  );

  it("says what was already removed when a later checkout fails", async () => {
    setup();
    state.delete
      .mockResolvedValueOnce(AsyncResult.success(undefined))
      .mockResolvedValueOnce(
        AsyncResult.failure(Cause.fail(new Error("Server unavailable"))) as never,
      );
    await using screen = await mountPanel();

    await userEvent.click(removeAll(screen));
    await vi.waitFor(() =>
      expect(state.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: expect.stringMatching(/^Failed to remove "Shared repo" on /),
          description:
            "Server unavailable. 1 other checkout was already removed, and some of this one's threads may be deleted. Try again to finish.",
        }),
      ),
    );
  });

  // regression: a checkout whose machine dropped partway was said to have lost threads it never sent
  it("says nothing was sent for a checkout whose machine dropped partway", async () => {
    setup();
    state.delete.mockResolvedValueOnce(AsyncResult.success(undefined)).mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(
          new EnvironmentRpcUnavailableError({
            environmentId: remoteId,
            message: "remote is not connected.",
          }),
        ),
      ) as never,
    );
    await using screen = await mountPanel();

    await userEvent.click(removeAll(screen));
    await vi.waitFor(() =>
      expect(state.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: expect.stringMatching(/^Failed to remove "Shared repo" on /),
          description:
            "remote isn't connected. 1 other checkout was already removed. Connect remote and try again.",
        }),
      ),
    );
  });

  // regression: the system confirm asked first, then the removal failed on the offline machine
  it("disables an offline machine's removals, and refuses one whose machine drops first", async () => {
    setup();
    // Dropped after its session loaded, so its grant is still known.
    state.offline.add(remoteId);
    await using screen = await mountPanel();
    expect(removeCheckout(screen, "/work/remote").disabled).toBe(true);
    expect(removeAll(screen).disabled).toBe(true);
    await expect.element(page.getByText("Connect remote to remove it.")).toBeVisible();
    await expect.element(page.getByText("Connect remote to remove them.")).toBeVisible();
    // Shared edits write to every checkout, so they wait too.
    expect(nameInput(screen).disabled).toBe(true);
    expect(screen.container.textContent).toContain("Connect remote to change this project.");

    // Offline since the app started, its session never loaded: a reason to connect, not a refusal.
    await grant(remoteId, AsyncResult.initial());
    await expect.element(page.getByText("Connect remote to remove it.")).toBeVisible();
    expect(screen.container.textContent).not.toContain("can't change projects");

    // Back with its settings, its threads can still be stale, and the confirmation counts them.
    state.offline.delete(remoteId);
    await act(() => appAtomRegistry.set(state.liveShell, new Set([primaryId])));
    const loading = page.getByText("remote is still loading…");
    await expect.element(loading.first()).toBeVisible();
    // Its row, the Danger row, and the page's note for shared edits.
    expect(loading.elements()).toHaveLength(3);
    expect(removeCheckout(screen, "/work/remote").disabled).toBe(true);
    expect(removeAll(screen).disabled).toBe(true);

    // This mock doesn't re-render, as a click can land before the panel sees the drop.
    state.offline.add(primaryId);
    await userEvent.click(removeCheckout(screen, "/work/primary"));
    await vi.waitFor(() =>
      expect(state.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Failed to remove project",
          description: "Connect primary and try again.",
        }),
      ),
    );
    // So is one whose threads go stale as the click lands, before the panel updates.
    state.offline.delete(primaryId);
    await act(() => {
      appAtomRegistry.set(state.liveShell, new Set());
      removeCheckout(screen, "/work/primary").click();
    });
    await vi.waitFor(() =>
      expect(state.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "primary is still loading. Try again in a moment.",
        }),
      ),
    );
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.delete).not.toHaveBeenCalled();
  });

  // A confirmation can wait a while, so what it was asked about can change before it returns.
  it.each([
    [
      "its grant is revoked",
      () => grant(remoteId, AsyncResult.success(session([]))),
      "This connection can't change projects on remote.",
    ],
    [
      "its threads start reloading",
      () => act(() => appAtomRegistry.set(state.liveShell, new Set([primaryId]))),
      "remote is still loading. Try again in a moment.",
    ],
  ])(
    "rechecks every removal target after confirmation, here when %s, before deleting or clearing drafts",
    async (_case, change, description) => {
      setup();
      const confirmed = deferred<boolean>();
      state.confirm.mockReturnValueOnce(confirmed.promise);
      await using screen = await mountPanel();
      await userEvent.click(removeAll(screen));
      expect(state.confirm).toHaveBeenCalledOnce();

      await change();
      await act(async () => {
        confirmed.resolve(true);
        await confirmed.promise;
      });
      await vi.waitFor(() =>
        expect(state.toast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            title: "Failed to remove project",
            description,
          }),
        ),
      );
      expect(state.toast).toHaveBeenCalledOnce();
      expect(state.delete).not.toHaveBeenCalled();
      expect(state.releaseUploads).not.toHaveBeenCalled();
      expect(state.clearDraft).not.toHaveBeenCalled();
    },
  );

  // regression: a thread that started while the system confirm waited was stopped unasked
  it("asks again when a thread starts running while the confirmation waits", async () => {
    setup();
    const confirmed = deferred<boolean>();
    state.confirm.mockReturnValueOnce(confirmed.promise);
    await using screen = await mountPanel();
    await userEvent.click(removeAll(screen));
    expect(state.confirm).toHaveBeenCalledOnce();

    const threadId = ThreadId.make("new-work");
    state.threads = [
      {
        id: threadId,
        environmentId: remoteId,
        projectId: ProjectId.make(`project-${remoteId}`),
        title: "New work",
        lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
        runtime: {
          status: "running",
          activeRunId: null,
          providerInstanceId: instanceId,
          providerName: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      } as unknown as EnvironmentThreadShell,
    ];
    await act(async () => {
      confirmed.resolve(true);
      await confirmed.promise;
    });
    await vi.waitFor(() => expect(state.confirm).toHaveBeenCalledTimes(2));
    // What changed opens the question, which the app's confirm dialog uses as its title.
    expect(state.confirm.mock.calls[1]![0].split("\n")[0]).toBe(
      'Now stops "New work". Remove project "Shared repo" and delete its 1 thread?',
    );
    // Confirming what changed goes ahead.
    await vi.waitFor(() => expect(state.delete).toHaveBeenCalledTimes(2));
  });

  // regression: Chromium takes focus off a newly disabled input without a blur, so an edit
  // stayed in the dimmed field, unsaved and unexplained
  it.each([
    [
      "its grant is revoked",
      () => grant(remoteId, AsyncResult.success(session([]))),
      () => grant(remoteId, writable()),
    ],
    [
      "its machine drops",
      // The connection mock doesn't re-render, so a fresh grant result does.
      () => {
        state.offline.add(remoteId);
        return grant(remoteId, writable());
      },
      () => {
        state.offline.delete(remoteId);
        return grant(remoteId, writable());
      },
    ],
  ])(
    "brings back the saved name when a wait starts mid-edit, here when %s, and recovers",
    async (_case, wait, restore) => {
      setup();
      // Titles that differ from the label, so a blur counted as an edit would retitle both.
      state.projects = state.projects.map((project, index) =>
        index === 1 ? { ...project, title: "Shared repo fork" } : project,
      );
      await using screen = await mountPanel();
      const saved = nameInput(screen).value;
      await userEvent.fill(nameInput(screen), "Renamed");
      await wait();
      expect(nameInput(screen).disabled).toBe(true);
      expect(nameInput(screen).value).toBe(saved);
      // No blur reaches the field as it goes, so nothing was tried or refused.
      expect(state.update).not.toHaveBeenCalled();
      expect(state.toast).not.toHaveBeenCalled();

      await restore();
      expect(nameInput(screen).disabled).toBe(false);
      // Visiting the field again without typing isn't the abandoned edit coming back.
      await userEvent.click(nameInput(screen));
      await userEvent.tab();
      expect(state.update).not.toHaveBeenCalled();
      await rename(screen, "Recovered");
      await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
      expect(nameInput(screen).value).toBe("Recovered");
    },
  );

  it.each([
    ["loading", () => AsyncResult.initial<AuthSessionState, Error>(), false],
    [
      "failed",
      () => AsyncResult.failure<AuthSessionState, Error>(Cause.fail(new Error("Disconnected"))),
      false,
    ],
    ["refreshing", () => AsyncResult.waiting(writable()), true],
  ] as const)(
    "uses the current grant while a member's session is %s",
    async (_state, result, allowed) => {
      setup();
      await grant(remoteId, result());
      await using screen = await mountPanel();
      expect(nameInput(screen).disabled).toBe(!allowed);
      if (!allowed) return;
      await rename(screen, "Renamed");
      expect(state.update).toHaveBeenCalledTimes(2);
    },
  );
});

describe("project identity reset", () => {
  const scratchIcon = { kind: "lucide", name: "message-square-dashed", color: "gray" } as const;
  const resetButton = (screen: Screen, label: string) =>
    screen.container.querySelector<HTMLButtonElement>(`[aria-label="Reset ${label} to default"]`);
  const asScratch = (project: Project): Project => ({
    ...project,
    isScratch: true,
    title: "Notes",
    workspaceRoot: "/t3/scratch",
    projectIcon: { kind: "emoji", emoji: "📝" },
  });

  it("restores a renamed scratch project's built-in name and icon", async () => {
    setup();
    state.projects = [{ ...asScratch(state.projects[0]!), faviconPath: null, projectIcon: null }];
    await using screen = await mountPanel();

    await userEvent.click(resetButton(screen, "project name")!);
    await vi.waitFor(() =>
      expect(state.update).toHaveBeenCalledWith({
        environmentId: primaryId,
        input: { projectId: state.projects[0]!.id, title: "No project" },
      }),
    );
    await userEvent.click(resetButton(screen, "project icon")!);
    await vi.waitFor(() =>
      expect(state.update).toHaveBeenLastCalledWith({
        environmentId: primaryId,
        input: { projectId: state.projects[0]!.id, faviconPath: null, projectIcon: scratchIcon },
      }),
    );
  });

  it("resets each member of a mixed group to its own default icon", async () => {
    setup();
    const [primary, remote] = state.projects;
    state.projects = [asScratch(primary!), { ...remote!, faviconPath: "logo.png" }];
    await using screen = await mountPanel();

    expect(resetButton(screen, "project name")).toBeNull();
    await userEvent.click(resetButton(screen, "project icon")!);
    await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
    expect(state.update.mock.calls.map(([request]) => request)).toEqual([
      {
        environmentId: primaryId,
        input: { projectId: primary!.id, faviconPath: null, projectIcon: scratchIcon },
      },
      {
        environmentId: remoteId,
        input: { projectId: remote!.id, faviconPath: null, projectIcon: null },
      },
    ]);
  });
});

it("opens the fallback search target across all environments from a checkout", async () => {
  setup();
  const root = createRootRoute();
  const settings = createRoute({
    getParentRoute: () => root,
    path: "settings",
    validateSearch: validateSettingsRouteSearch,
    search: { middlewares: [retainSettingsScope] },
  });
  const threads = createRoute({
    getParentRoute: () => settings,
    path: "threads",
    component: () => (
      <SettingsScopeProvider search={settings.useSearch()} onChange={() => {}}>
        <SettingsScopeNotice target="all" targetId="fallback-model">
          Choose all environments to edit the fallback model.
        </SettingsScopeNotice>
      </SettingsScopeProvider>
    ),
  });
  const query = new URLSearchParams({
    project: projectKey(),
    machine: primaryId,
    checkout: "primary:/work/primary",
  });
  const router = createRouter({
    routeTree: root.addChildren([settings.addChildren([threads])]),
    history: createMemoryHistory({ initialEntries: [`/settings/threads?${query}#fallback-model`] }),
  });
  await router.load();
  // This route needs the real scope-retention middleware used by settings search.
  await using _screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <RouterProvider router={router} />
    </RegistryContext.Provider>,
    { router: false },
  );
  await userEvent.click(page.getByRole("button", { name: "Open all environments" }));
  await vi.waitFor(() => expect(router.state.location.search).toEqual({}));
  expect(router.state.location.hash).toBe("fallback-model");
});

describe("project settings scope", () => {
  const environmentMenu = () => page.getByRole("button", { name: /^Environment scope:/ });
  const primaryOption = () => page.getByRole("menuitemradio", { name: /^primary/ });
  const remoteOption = () => page.getByRole("menuitemradio", { name: /^remote/ });

  it("offers every environment while no project is selected", async () => {
    setup();
    state.projects = state.projects.filter((project) => project.environmentId === primaryId);
    await using _screen = await mountSettings({});

    await userEvent.click(environmentMenu());
    await expect.element(primaryOption()).toBeVisible();
    await expect.element(remoteOption()).toBeVisible();
  });

  it("offers only the selected project's checkout environments", async () => {
    setup();
    state.projects = state.projects.filter((project) => project.environmentId === primaryId);
    await using _screen = await mountSettings({ project: projectKey() });

    await expect.element(page.getByRole("textbox", { name: "Project name" })).toBeVisible();
    await userEvent.click(environmentMenu());
    await expect.element(primaryOption()).toBeVisible();
    await expect.element(remoteOption()).not.toBeInTheDocument();
  });

  it("keeps an unknown project recoverable from any environment", async () => {
    setup();
    state.projects = state.projects.filter((project) => project.environmentId === primaryId);
    await using screen = await mountSettings({ project: "removed-project" });

    await userEvent.click(environmentMenu());
    await expect.element(primaryOption()).toBeVisible();
    await expect.element(remoteOption()).toBeVisible();
    await userEvent.click(remoteOption());
    await vi.waitFor(() =>
      expect(screen.router.state.location.search).toEqual({
        project: "removed-project",
        machine: remoteId,
      }),
    );
  });

  // regression: the scope pickers remount the page, which dropped the removal underway, and a key
  // read from the scope on screen stopped matching it after a switch
  it.each([
    {
      change: "from one machine to all",
      from: { machine: primaryId },
      to: {},
      press: "Remove checkout",
      // Only primary goes: its row says so, and remote's own Remove doesn't wait.
      expectUnderway: async (screen: Screen) => {
        await expect
          .element(page.getByRole("button", { name: "Remove both checkouts" }))
          .toHaveAttribute("aria-disabled", "true");
        expect(removeCheckout(screen, "/work/primary")).toHaveAttribute("aria-disabled", "true");
        expect(removeCheckout(screen, "/work/remote")).not.toHaveAttribute("aria-disabled");
      },
      // The rest of the project stays, so the page does too.
      expectEnd: async () => {
        await dropCheckout("/work/primary");
        await vi.waitFor(() => expect(page.getByRole("status").element().textContent).toBe(""));
      },
    },
    {
      change: "from all machines to one",
      from: {},
      to: { machine: primaryId },
      press: "Remove both checkouts",
      expectUnderway: async () => {
        await expect
          .element(page.getByRole("button", { name: "Removing…" }))
          .toHaveAttribute("aria-disabled", "true");
      },
      // The project is gone from every scope, so the narrower one has nothing left to show.
      expectEnd: async (screen: SettingsScreen) => {
        await dropCheckout("/work/primary");
        await dropCheckout("/work/remote");
        await vi.waitFor(() =>
          expect(screen.router.state.location.search).toEqual({ machine: primaryId }),
        );
      },
    },
  ])(
    "keeps a removal underway when the scope changes $change",
    async ({ from, to, press, expectUnderway, expectEnd }) => {
      setup();
      const deletion = deferred<AsyncResult.Success<void>>();
      state.delete.mockReturnValueOnce(deletion.promise);
      const key = projectKey();
      await using screen = await mountSettings({ project: key, ...from });
      await userEvent.click(page.getByRole("button", { name: press, exact: true }));
      await vi.waitFor(() => expect(state.delete).toHaveBeenCalledOnce());

      await act(() =>
        screen.router.navigate({ to: "/settings/projects", search: { project: key, ...to } }),
      );
      await expectUnderway(screen);
      expect(page.getByRole("status").element()).toHaveTextContent("Removing…");

      await act(async () => {
        deletion.resolve(AsyncResult.success(undefined));
        await deletion.promise;
      });
      await vi.waitFor(() =>
        expect(state.clearDraft).toHaveBeenCalledTimes(press === "Remove checkout" ? 1 : 2),
      );
      await expectEnd(screen);
    },
  );

  // regression: the removal underway made every Remove wait, another project's too, and finishing
  // it took the user from that project's page to the list
  it("leaves another project alone while a removal runs", async () => {
    setup();
    state.projects = [
      ...state.projects,
      {
        ...state.projects[0]!,
        id: ProjectId.make("project-docs"),
        title: "Docs",
        workspaceRoot: "/work/docs",
        repositoryIdentity: {
          canonicalKey: "github.com/example/docs",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://github.com/example/docs.git",
          },
        },
      },
    ];
    const deletion = deferred<AsyncResult.Success<void>>();
    state.delete.mockReturnValueOnce(deletion.promise);
    await using screen = await mountSettings({ project: projectKey("/work/primary") });
    await userEvent.click(page.getByRole("button", { name: "Remove both checkouts" }));
    await vi.waitFor(() => expect(state.delete).toHaveBeenCalledOnce());

    const docs = projectKey("/work/docs");
    await act(() =>
      screen.router.navigate({ to: "/settings/projects", search: { project: docs } }),
    );
    await expect
      .element(page.getByRole("button", { name: "Remove project", exact: true }))
      .not.toHaveAttribute("aria-disabled");
    expect(page.getByRole("status").element().textContent).toBe("");

    await act(async () => {
      deletion.resolve(AsyncResult.success(undefined));
      await deletion.promise;
    });
    await vi.waitFor(() => expect(state.clearDraft).toHaveBeenCalledTimes(2));
    await dropCheckout("/work/primary");
    await dropCheckout("/work/remote");
    expect(screen.router.state.location.search).toEqual({ project: docs });
    await expect.element(page.getByRole("textbox", { name: "Project name" })).toHaveValue("Docs");
  });

  it.each([
    [undefined, "This project has no checkout on this environment."],
    [
      "removed-checkout",
      "This checkout is no longer available in the selected project and environment.",
    ],
  ])("recovers a stale environment link with checkout %s", async (checkout, message) => {
    setup();
    state.projects = state.projects.filter((project) => project.environmentId === primaryId);
    const key = projectKey();
    await using screen = await mountSettings({
      project: key,
      machine: remoteId,
      ...(checkout ? { checkout } : {}),
    });

    await expect.element(page.getByText(message, { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: /^Project scope:/ })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Environment scope: remote" }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Show all environments" }));

    await expect
      .element(page.getByRole("textbox", { name: "Project name" }))
      .toHaveValue("Shared repo");
    expect(screen.router.state.location.search).toEqual({ project: key });
    await expect
      .element(page.getByRole("button", { name: "Environment scope: All environments" }))
      .toBeVisible();
    await expect.element(page.getByText(message, { exact: true })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Remove project", exact: true }))
      .toBeEnabled();
  });
});

it("returns to the project overview after removal, clearing the selection but keeping the environment", async () => {
  setup();
  state.projects = [state.projects[1]!];
  await using screen = await mountPanel({ machine: remoteId, checkout: "remote:/work/remote" });

  await userEvent.click(page.getByRole("button", { name: "Remove project", exact: true }));
  await vi.waitFor(() => expect(state.clearDraft).toHaveBeenCalledOnce());
  await dropCheckout("/work/remote");

  await vi.waitFor(() => {
    expect(screen.router.state.location.pathname).toBe("/settings/projects");
    expect(screen.router.state.location.search).toEqual({ machine: remoteId });
  });
});

// regression: the label followed the live list, which drops each checkout once its removal
// commits, so "Removing…" turned back into "Remove project" partway through
it("says Removing… until the last checkout goes, then returns to the project overview", async () => {
  setup();
  const firstDelete = deferred<AsyncResult.Success<void>>();
  const secondDelete = deferred<AsyncResult.Success<void>>();
  state.delete.mockReturnValueOnce(firstDelete.promise).mockReturnValueOnce(secondDelete.promise);
  await using screen = await mountPanel();
  await userEvent.click(removeAll(screen));
  await vi.waitFor(() => expect(state.delete).toHaveBeenCalledOnce());

  await act(async () => {
    firstDelete.resolve(AsyncResult.success(undefined));
    await firstDelete.promise;
  });
  await dropCheckout("/work/primary");
  await vi.waitFor(() => expect(state.delete).toHaveBeenCalledTimes(2));
  await expect
    .element(page.getByRole("button", { name: "Removing…" }))
    .toHaveAttribute("aria-disabled", "true");
  expect(page.getByRole("status").element()).toHaveTextContent("Removing…");

  await act(async () => {
    secondDelete.resolve(AsyncResult.success(undefined));
    await secondDelete.promise;
  });
  await vi.waitFor(() => expect(state.clearDraft).toHaveBeenCalledTimes(2));
  // The server is done, but a list that lags still shows remote, so it still says it's going.
  await expect
    .element(page.getByRole("button", { name: "Removing…" }))
    .toHaveAttribute("aria-disabled", "true");
  await dropCheckout("/work/remote");
  await vi.waitFor(() => expect(screen.router.state.location.search).toEqual({}));
});

// regression: checkouts removed one at a time, at the same time, each left the rest of the project,
// so neither took the page back once both were gone
it("returns to the project overview when removals of single checkouts take the whole project", async () => {
  setup();
  const first = deferred<AsyncResult.Success<void>>();
  const second = deferred<AsyncResult.Success<void>>();
  state.delete.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await using screen = await mountPanel();
  await userEvent.click(removeCheckout(screen, "/work/primary"));
  await vi.waitFor(() => expect(state.delete).toHaveBeenCalledOnce());
  await userEvent.click(removeCheckout(screen, "/work/remote"));
  await vi.waitFor(() => expect(state.delete).toHaveBeenCalledTimes(2));

  await act(async () => {
    first.resolve(AsyncResult.success(undefined));
    second.resolve(AsyncResult.success(undefined));
    await Promise.all([first.promise, second.promise]);
  });
  await dropCheckout("/work/primary");
  await dropCheckout("/work/remote");
  await vi.waitFor(() => expect(screen.router.state.location.search).toEqual({}));
});

// regression: "Remove this project everywhere" left the page even when a checkout joined while
// its confirmation waited, as if the project were gone
it("stays on a project that a checkout joined while its removal was being confirmed", async () => {
  setup();
  const [primary, remote] = state.projects;
  state.projects = [primary!];
  const answer = deferred<boolean>();
  state.confirm.mockReturnValueOnce(answer.promise);
  const key = projectKey();
  await using screen = await mountSettings({ project: key });

  await userEvent.click(page.getByRole("button", { name: "Remove project", exact: true }));
  await vi.waitFor(() => expect(state.confirm).toHaveBeenCalledOnce());
  await addCheckout(remote!);
  await act(async () => {
    answer.resolve(true);
    await answer.promise;
  });
  await vi.waitFor(() => expect(state.clearDraft).toHaveBeenCalledOnce());
  await dropCheckout("/work/primary");

  expect(state.delete).toHaveBeenCalledOnce();
  expect(screen.router.state.location.search).toEqual({ project: key });
  await expect
    .element(page.getByRole("button", { name: "Remove project", exact: true }))
    .toBeVisible();
  expect(screen.container.textContent).toContain("/work/remote");

  // regression: the page then left for the list once the project's key went, even when its last
  // checkout had only moved to another project
  await setProjects(
    state.projects.map((project) =>
      project.workspaceRoot === "/work/remote"
        ? {
            ...project,
            repositoryIdentity: {
              canonicalKey: "github.com/example/fork",
              locator: {
                source: "git-remote",
                remoteName: "origin",
                remoteUrl: "https://github.com/example/fork.git",
              },
            },
          }
        : project,
    ),
  );
  const fork = projectKey("/work/remote");
  expect(fork).not.toBe(key);
  await vi.waitFor(() => expect(screen.router.state.location.search).toEqual({ project: fork }));
});

describe("project name composition", () => {
  it.each([
    { isComposing: true, keyCode: 13 },
    { isComposing: false, keyCode: 229 },
  ])("does not save a partial name for $isComposing/$keyCode", async (composition) => {
    setup();
    await using screen = await mountPanel();
    const input = nameInput(screen);
    await userEvent.fill(input, "日本");
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...composition }),
      );
    });
    expect(state.update).not.toHaveBeenCalled();
    await expect.element(input).toHaveFocus();

    await userEvent.type(input, "語");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
    expect(state.projects.map((project) => project.title)).toEqual(["日本語", "日本語"]);
    await expect.element(nameInput(screen)).toHaveValue("日本語");

    await userEvent.fill(nameInput(screen), "日本語の名前");
    await userEvent.keyboard("{Tab}");
    await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(4));
    expect(state.projects.map((project) => project.title)).toEqual([
      "日本語の名前",
      "日本語の名前",
    ]);
  });
});
