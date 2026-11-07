import { RegistryContext } from "@effect/atom-react";
import type {
  DeleteProjectInput,
  UpdateProjectInput,
} from "@t3tools/client-runtime/state/projects";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
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
  useLocation,
} from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render, type Screen } from "../../../test/render";
import type { Project } from "../../types";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
const state = vi.hoisted(() => ({
  sessions: new Map<EnvironmentId, Atom.Writable<SessionResult>>(),
  projects: [] as Project[],
  unloaded: new Set<EnvironmentId>(),
  connecting: new Set<EnvironmentId>(),
  oneEnvironment: false,
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
  confirm: vi.fn<() => Promise<boolean>>(),
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
  useEnvironments: (() => ({
    environments: state.oneEnvironment ? environments.slice(0, 1) : environments,
  })) as never,
  readEnvironment: ((id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id) ?? null) as never,
  usePrimaryEnvironmentId: () => primaryId,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => state.projects) as never,
  useThreadShells: () => [],
  useServerConfigs: (() =>
    new Map(
      environments.map((environment) => [environment.environmentId, environment.serverConfig]),
    )) as never,
  waitForProjectRemoval: async () => true,
  useAllEnvironmentShellsBootstrapped: () => state.connecting.size === 0,
}));
// Environments that never loaded a snapshot; tests add one to stand for a failed first connection.
// A connecting environment has no snapshot yet either, but has not settled as disconnected.
vi.mock(import("~/state/shell"), async (original) => ({
  ...(await original()),
  useUnloadedShellEnvironmentIds: (() => state.unloaded) as never,
  useEnvironmentShellsBootstrapped: ((environmentId: EnvironmentId | null) =>
    environmentId === null
      ? state.connecting.size === 0
      : !state.connecting.has(environmentId)) as never,
}));
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
import { SettingsScopeUnavailable } from "./SettingsScopeStatus";
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
  state.unloaded = new Set();
  state.connecting = new Set();
  state.oneEnvironment = false;
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

function projectKey() {
  return buildSidebarProjectSnapshots({
    projects: state.projects,
    settings: DEFAULT_CLIENT_SETTINGS,
    primaryEnvironmentId: primaryId,
    resolveEnvironmentLabel: (id) => id,
  })[0]!.projectKey;
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
  const worktreesRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: "worktrees",
    component: () => <p>Worktrees page</p>,
  });
  const query = new URLSearchParams({ project: key });
  for (const [name, value] of Object.entries(search)) {
    if (value !== undefined) query.set(name, value);
  }
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute.addChildren([projectsRoute, worktreesRoute])]),
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

async function mountSettings(search: SettingsScopeSearch, hash = "") {
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
      initialEntries: [`/settings/projects?${searchParams.toString()}${hash ? `#${hash}` : ""}`],
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
const removeCheckout = (screen: Screen, name: string) =>
  screen.container.querySelector<HTMLButtonElement>(`[aria-label="Remove checkout ${name}"]`)!;
const removeAll = (screen: Screen) =>
  [...screen.container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Remove project"),
  )!;

async function grant(id: EnvironmentId, result: SessionResult) {
  await act(async () => appAtomRegistry.set(state.sessions.get(id)!, result));
}

async function rename(screen: Screen, title: string) {
  await userEvent.fill(nameInput(screen), title);
  await userEvent.keyboard("{Enter}");
}

// The recheck reports the denial by toast; seeing it proves the recheck ran.
async function expectProjectAccessDeniedToast(title: string) {
  await vi.waitFor(() =>
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title,
        description: "This connection cannot change projects in remote.",
      }),
    ),
  );
  expect(state.toast).toHaveBeenCalledOnce();
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
});

describe("project settings permissions", () => {
  it("disables shared edits when any member lacks project access", async () => {
    setup();
    await grant(remoteId, AsyncResult.success(session([AuthSettingsWriteScope])));
    await using screen = await mountPanel();

    expect(nameInput(screen).disabled).toBe(true);
    expect(removeAll(screen).disabled).toBe(true);
    expect(screen.container.textContent).toContain(
      "Shared settings require permission to change every checkout in this group.",
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

  it("stops before the next member if its grant is revoked during an earlier update", async () => {
    setup();
    const firstUpdate = deferred<AsyncResult.Success<void>>();
    state.update.mockReturnValueOnce(firstUpdate.promise);
    await using screen = await mountPanel();
    await rename(screen, "Renamed");
    expect(state.update).toHaveBeenCalledOnce();

    await grant(remoteId, AsyncResult.success(session([])));
    await act(async () => {
      firstUpdate.resolve(AsyncResult.success(undefined));
      await firstUpdate.promise;
    });
    await expectProjectAccessDeniedToast("Failed to rename project");
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]![0].environmentId).toBe(primaryId);
  });

  it("disables removal for a checkout whose project grant is missing", async () => {
    setup();
    await grant(remoteId, AsyncResult.success(session([])));
    await using screen = await mountPanel();
    expect(removeCheckout(screen, "/work/remote on remote").disabled).toBe(true);
    expect(removeCheckout(screen, "/work/primary on primary").disabled).toBe(false);
  });

  it("removes a writable checkout while removal of the mixed group stays denied", async () => {
    setup();
    await grant(remoteId, AsyncResult.success(session([])));
    await using screen = await mountPanel();
    const initialHref = screen.router.state.location.href;
    expect(removeAll(screen).disabled).toBe(true);

    await userEvent.click(removeCheckout(screen, "/work/primary on primary"));
    await vi.waitFor(() => expect(state.delete).toHaveBeenCalledOnce());
    expect(state.delete).toHaveBeenCalledWith({
      environmentId: primaryId,
      input: { projectId: state.projects[0]!.id, force: true },
    });
    await vi.waitFor(() => expect(state.releaseUploads).toHaveBeenCalledOnce());
    expect(state.clearDraft).toHaveBeenCalledOnce();
    expect(screen.router.state.location.href).toBe(initialHref);
  });

  it("rechecks every removal target after confirmation before deleting or clearing drafts", async () => {
    setup();
    const confirmed = deferred<boolean>();
    state.confirm.mockReturnValueOnce(confirmed.promise);
    await using screen = await mountPanel();
    await userEvent.click(removeAll(screen));
    expect(state.confirm).toHaveBeenCalledOnce();

    await grant(remoteId, AsyncResult.success(session([])));
    await act(async () => {
      confirmed.resolve(true);
      await confirmed.promise;
    });
    await expectProjectAccessDeniedToast("Failed to remove project");
    expect(state.delete).not.toHaveBeenCalled();
    expect(state.releaseUploads).not.toHaveBeenCalled();
    expect(state.clearDraft).not.toHaveBeenCalled();
  });

  it("drops an edit whose grant was revoked mid-edit, and recovers when restored", async () => {
    setup();
    await using screen = await mountPanel();
    await userEvent.fill(nameInput(screen), "Renamed");
    // Chromium takes focus off a newly disabled input without firing blur, so the field must
    // drop the unsaved text on its own.
    await grant(remoteId, AsyncResult.success(session([])));
    expect(nameInput(screen).disabled).toBe(true);
    await expect.element(nameInput(screen)).toHaveValue("Shared repo");
    expect(state.update).not.toHaveBeenCalled();

    await grant(remoteId, writable());
    expect(nameInput(screen).disabled).toBe(false);
    await rename(screen, "Recovered");
    await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
    expect(nameInput(screen).value).toBe("Recovered");
  });

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
  const allProjects = page.getByRole("button", { name: "All projects and environments" });
  // A search result focuses the way to the scope it needs, as the project list does.
  await expect.element(allProjects).toHaveFocus();
  await userEvent.click(allProjects);
  await vi.waitFor(() => expect(router.state.location.search).toEqual({}));
  expect(router.state.location.hash).toBe("fallback-model");
});

describe("project settings scope", () => {
  const environmentMenu = () => page.getByRole("button", { name: /, environment$/ });
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

  it("lists loaded projects with a way to reconnect an environment that never loaded", async () => {
    setup();
    state.projects = state.projects.filter((project) => project.environmentId === primaryId);
    state.unloaded = new Set([remoteId]);
    await using _screen = await mountSettings({});

    await expect
      .element(
        page.getByText(/^Choose a project to manage .+ Reconnect remote to load its projects\.$/),
      )
      .toBeVisible();
    await expect.element(page.getByRole("link", { name: "Open Environments" })).toBeVisible();
  });

  it("says an environment has no projects while another is still connecting", async () => {
    setup();
    state.projects = [];
    state.unloaded = new Set([remoteId]);
    state.connecting = new Set([remoteId]);
    await using _screen = await mountSettings({ machine: primaryId });

    await expect.element(page.getByText("No projects on primary.")).toBeVisible();
  });

  it("offers to add a project when the only environment has none", async () => {
    setup();
    state.oneEnvironment = true;
    state.projects = [];
    await using _screen = await mountSettings({ machine: primaryId });

    await expect.element(page.getByRole("button", { name: "Add project" })).toBeVisible();
    expect(page.getByRole("button", { name: "Show all environments" }).query()).toBeNull();
  });

  it("keeps a waiting search's message and Cancel when the list is empty", async () => {
    setup();
    state.projects = state.projects.filter((project) => project.environmentId === remoteId);
    await using _screen = await mountSettings({ machine: primaryId }, "project-remove");

    await expect
      .element(page.getByText(/^Choose a project to jump to "Remove project"\./))
      .toBeVisible();
    // The result takes focus, as a list's first choice would.
    await expect.element(page.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await expect.element(page.getByText("No projects on primary.")).toBeVisible();
  });

  it("leaves focus where the user moved it when projects arrive under a waiting search", async () => {
    setup();
    const bravo = {
      ...state.projects[0]!,
      id: ProjectId.make("project-bravo"),
      title: "Bravo",
      workspaceRoot: "/work/bravo",
      repositoryIdentity: null,
    };
    state.projects = [];
    // Projects arrive without a navigation, the way an environment's snapshot does.
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const root = createRootRoute({
      validateSearch: validateSettingsScopeSearch,
      component: function WaitingSearch() {
        // Stands in for the settings route, which shows the empty list's note until projects load.
        const hash = useLocation({ select: (location) => location.hash });
        useSyncExternalStore(subscribe, () => state.projects);
        return (
          <SettingsScopeProvider search={root.useSearch()} onChange={() => {}}>
            <input aria-label="Search settings" />
            {hash && state.projects.length > 0 ? (
              <SettingsScopeNotice key={hash} target="project" targetId={hash}>
                Choose a project to jump to "Remove project".
              </SettingsScopeNotice>
            ) : (
              <ProjectsSettings />
            )}
          </SettingsScopeProvider>
        );
      },
    });
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({ initialEntries: ["/settings/projects"] }),
    });
    await router.load();
    // The settings route tree above validates scope search params, which the default router lacks.
    await using _screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <RouterProvider router={router} />
      </RegistryContext.Provider>,
      { router: false },
    );
    await router.navigate({ to: "/settings/projects", search: {}, hash: "project-remove" });
    await expect.element(page.getByRole("button", { name: "Cancel" })).toHaveFocus();
    const search = page.getByRole("textbox", { name: "Search settings" });
    await userEvent.click(search);

    state.projects = [bravo];
    await act(async () => {
      for (const listener of listeners) listener();
    });

    await expect.element(page.getByRole("button", { name: "Bravo", exact: true })).toBeVisible();
    await expect.element(search).toHaveFocus();
  });

  it("focuses a new search's first project after returning to the list", async () => {
    setup();
    const root = createRootRoute({
      validateSearch: validateSettingsScopeSearch,
      component: function ProjectsWithSearch() {
        // Stands in for the settings route, which lists projects while a search needs one.
        const hash = useLocation({ select: (location) => location.hash });
        return (
          <SettingsScopeProvider search={root.useSearch()} onChange={() => {}}>
            {hash ? (
              <SettingsScopeNotice key={hash} target="project" targetId={hash}>
                Choose a project to jump to "Remove project".
              </SettingsScopeNotice>
            ) : (
              <ProjectsSettings />
            )}
          </SettingsScopeProvider>
        );
      },
    });
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({
        initialEntries: [`/settings/projects?${new URLSearchParams({ project: projectKey() })}`],
      }),
    });
    await router.load();
    // The settings route tree above validates scope search params, which the default router lacks.
    await using _screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <RouterProvider router={router} />
      </RegistryContext.Provider>,
      { router: false },
    );
    await expect.element(page.getByRole("textbox", { name: "Project name" })).toBeVisible();
    const row = page.getByRole("button", { name: "Shared repo", exact: true });

    await router.navigate({ to: "/settings/projects", search: {} });
    await expect.element(row).toBeVisible();
    await router.navigate({ to: "/settings/projects", search: {}, hash: "project-remove" });

    await expect.element(page.getByText(/^Choose a project to jump to/)).toBeVisible();
    await expect.element(row).toHaveFocus();
  });

  it("leaves focus where the user moved it when a search's project list re-sorts", async () => {
    setup();
    const project = (title: string) => ({
      ...state.projects[0]!,
      id: ProjectId.make(`project-${title}`),
      title,
      workspaceRoot: `/work/${title}`,
      repositoryIdentity: null,
    });
    state.projects = [project("Bravo"), project("Charlie")];
    const root = createRootRoute({
      validateSearch: validateSettingsScopeSearch,
      component: function SearchList() {
        // A hash change re-renders the list, standing in for another environment's projects arriving.
        useLocation({ select: (location) => location.hash });
        return (
          <SettingsScopeProvider search={root.useSearch()} onChange={() => {}}>
            <SettingsScopeNotice target="project" targetId="project-remove">
              Choose a project to jump to "Remove project".
            </SettingsScopeNotice>
          </SettingsScopeProvider>
        );
      },
    });
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({ initialEntries: ["/settings/projects"] }),
    });
    await router.load();
    // The settings route tree above validates scope search params, which the default router lacks.
    await using _screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <RouterProvider router={router} />
      </RegistryContext.Provider>,
      { router: false },
    );
    const row = (name: string) => page.getByRole("button", { name, exact: true });
    await expect.element(row("Bravo")).toHaveFocus();
    await userEvent.tab();
    await expect.element(row("Charlie")).toHaveFocus();

    state.projects = [project("Alpha"), ...state.projects];
    await router.navigate({ to: "/settings/projects", hash: "loaded" });

    await expect.element(row("Alpha")).toBeVisible();
    await expect.element(row("Charlie")).toHaveFocus();
  });

  it.each([
    [{}, false],
    [{ machine: primaryId }, false],
    // A filter on an environment that is gone can only be cleared from the picker.
    [{ machine: remoteId }, true],
  ])("with one environment, shows the environment picker for %o: %s", async (search, shown) => {
    setup();
    state.oneEnvironment = true;
    state.projects = state.projects.filter((project) => project.environmentId === primaryId);
    await using _screen = await mountSettings(search);

    await expect.element(page.getByRole("button", { name: /, projects shown$/ })).toBeVisible();
    expect(environmentMenu().query() !== null).toBe(shown);
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

  it("asks to reconnect an unloaded environment before calling a project gone", async () => {
    setup();
    state.projects = state.projects.filter((project) => project.environmentId === primaryId);
    state.unloaded = new Set([remoteId]);
    await using _screen = await mountSettings({ project: "removed-project" });

    await expect
      .element(page.getByText("Reconnect remote to load its projects.", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText("This project was removed, or the link to it is out of date."))
      .not.toBeInTheDocument();
    const back = page.getByRole("link", { name: "Back to projects" });
    await expect.element(back).toBeVisible();
    // The list shares the project page's path, so a loose match would call the way back the current page.
    await expect.element(back).not.toHaveAttribute("aria-current");
  });

  it("offers every project when a missing project is chosen on another settings page", async () => {
    setup();
    const root = createRootRoute({
      validateSearch: validateSettingsScopeSearch,
      component: function WorktreesPage() {
        return (
          <SettingsScopeProvider
            search={root.useSearch()}
            onChange={(next) => void router.navigate({ to: ".", search: () => next })}
          >
            <SettingsScopeUnavailable />
          </SettingsScopeProvider>
        );
      },
    });
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({
        initialEntries: ["/settings/worktrees?project=removed-project"],
      }),
    });
    await router.load();
    // The settings route tree above validates scope search params, which the default router lacks.
    await using _screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <RouterProvider router={router} />
      </RegistryContext.Provider>,
      { router: false },
    );

    await expect
      .element(page.getByText("This project was removed, or the link to it is out of date."))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Show all projects" }));
    await vi.waitFor(() => expect(router.state.location.search).toEqual({}));
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

  it.each([
    [undefined, false, "This project has no checkout on this environment."],
    [
      "removed-checkout",
      false,
      "This checkout is no longer available in the selected project and environment.",
    ],
    // An environment that never loaded cannot show the checkout is gone.
    [undefined, true, "Reconnect remote to load its projects."],
  ])("recovers a stale environment link with checkout %s", async (checkout, unloaded, message) => {
    setup();
    state.projects = state.projects.filter((project) => project.environmentId === primaryId);
    if (unloaded) state.unloaded = new Set([remoteId]);
    const key = projectKey();
    await using screen = await mountSettings({
      project: key,
      machine: remoteId,
      ...(checkout ? { checkout } : {}),
    });

    await expect.element(page.getByText(message, { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /, project( for .+ settings)?$/ }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "remote, environment" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Show all environments" }));

    await expect
      .element(page.getByRole("textbox", { name: "Project name" }))
      .toHaveValue("Shared repo");
    expect(screen.router.state.location.search).toEqual({ project: key });
    await expect
      .element(page.getByRole("button", { name: "All environments, environment" }))
      .toBeVisible();
    await expect.element(page.getByText(message, { exact: true })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Remove project", exact: true }))
      .toBeEnabled();
  });
});

it("returns to the project overview after removal, clearing the selection but keeping the environment", async () => {
  setup();
  const remote = state.projects[1]!;
  // The next project on the list takes the removed one's place, however its page was opened.
  const zeta = {
    ...remote,
    id: ProjectId.make("project-zeta"),
    title: "Zeta",
    workspaceRoot: "/work/zeta",
    repositoryIdentity: null,
  };
  state.projects = [remote, zeta];
  await using screen = await mountPanel({ machine: remoteId, checkout: "remote:/work/remote" });
  const removeProject = [...screen.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Remove project",
  )!;

  await userEvent.click(removeProject);

  await vi.waitFor(() => {
    expect(screen.router.state.location.pathname).toBe("/settings/projects");
    expect(screen.router.state.location.search).toEqual({ machine: remoteId });
  });
  expect(screen.router.state.location.state.settingsFocusProject).toBe(`${remoteId}:/work/zeta`);
});

it("focuses the link a project's page was left by on Back, and only on Back", async () => {
  setup();
  await using screen = await mountPanel();
  const worktrees = page.getByRole("link", { name: "Worktrees" });

  await userEvent.click(worktrees);
  await expect.element(page.getByText("Worktrees page")).toBeVisible();
  await act(async () => screen.router.history.back());
  await expect.element(worktrees).toHaveFocus();

  // Opening the page afresh starts at its top, wherever it was last left.
  await userEvent.click(worktrees);
  await expect.element(page.getByText("Worktrees page")).toBeVisible();
  await act(() => screen.router.navigate({ to: "/settings/projects" }));
  await expect.element(nameInput(screen)).toBeVisible();
  await expect.element(worktrees).not.toHaveFocus();
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

  it("shows the saved name again after refusing an empty one", async () => {
    setup();
    await using screen = await mountPanel();

    await rename(screen, "   ");

    await vi.waitFor(() =>
      expect(state.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Project name can't be empty" }),
      ),
    );
    await expect.element(nameInput(screen)).toHaveValue("Shared repo");
    expect(state.update).not.toHaveBeenCalled();
    // Enter saves without dropping focus to the page.
    await expect.element(nameInput(screen)).toHaveFocus();
  });
});
