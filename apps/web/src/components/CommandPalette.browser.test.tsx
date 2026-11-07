import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { makeThreadFixture } from "../test-fixtures";
import type { Project, Thread } from "../types";
import { CommandPalette } from "./CommandPalette";
import { retainSettingsScope } from "./settings/settingsScopeNavigation";

const entities = vi.hoisted(() => ({
  projects: [] as ReadonlyArray<Project>,
  threads: [] as ReadonlyArray<Thread>,
  bootstrapped: true,
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => entities.projects,
  useVisibleThreadShells: () => entities.threads,
  useAllEnvironmentShellsBootstrapped: () => entities.bootstrapped,
}));
vi.mock("./settings/useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [
    { id: "project-checkouts", title: "Checkouts", to: "/settings/projects" },
  ],
}));

function setup(
  state: {
    projects?: ReadonlyArray<Project>;
    threads?: ReadonlyArray<Thread>;
    bootstrapped?: boolean;
  } = {},
) {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  entities.projects = state.projects ?? [];
  entities.threads = state.threads ?? [];
  entities.bootstrapped = state.bootstrapped ?? true;
}

describe("CommandPalette open intents", () => {
  it("opens New thread in... with focus in the search input, not the Back button", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });

    await expect.element(page.getByPlaceholder("Search...")).toHaveFocus();
  });

  it("opens a search intent with its query in the focused input", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "acme" });

    const input = page.getByPlaceholder("Search commands, projects, and threads...");
    await expect.element(input).toHaveFocus();
    await expect.element(input).toHaveValue("acme");
  });

  it("opens a searched project's latest listed thread, not a newer subagent", async () => {
    const environmentId = EnvironmentId.make("local");
    const projectId = ProjectId.make("acme");
    const parentId = ThreadId.make("parent");
    setup({
      projects: [
        {
          id: projectId,
          environmentId,
          title: "Acme",
          workspaceRoot: "/work/acme",
          repositoryIdentity: null,
          defaultModelSelection: null,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
          scripts: [],
        },
      ],
      threads: [
        makeThreadFixture({
          id: parentId,
          environmentId,
          projectId,
          latestUserMessageAt: "2026-03-02T00:00:00.000Z",
        }),
        makeThreadFixture({
          id: ThreadId.make("subagent"),
          environmentId,
          projectId,
          updatedAt: "2026-03-03T00:00:00.000Z",
          lineage: {
            rootThreadId: parentId,
            parentThreadId: parentId,
            relationshipToParent: "subagent",
          },
        }),
      ],
    });
    await using screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "Acme" });
    await page.getByRole("option", { name: /Acme/ }).first().click();

    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/local/parent"));
  });
});

it.each([
  // A project on an environment still loading is not gone yet, so its key stays.
  { projects: "loading", bootstrapped: false, search: { project: "unlisted" } },
  { projects: "loaded", bootstrapped: true, search: {} },
])(
  "opens a project result from an unlisted project's settings with projects $projects",
  async ({ bootstrapped, search }) => {
    setup({ bootstrapped });
    const root = createRootRoute({
      search: { middlewares: [retainSettingsScope] },
      component: () => <CommandPalette>{null}</CommandPalette>,
    });
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({ initialEntries: ["/settings/worktrees?project=unlisted"] }),
    });
    await router.load();
    // Settings keep their project through retainSettingsScope, which the default router lacks.
    await using _screen = await render(<RouterProvider router={router} />, { router: false });

    openCommandPalette({ query: "checkouts" });
    await page.getByRole("option", { name: /Checkouts/ }).click();

    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/settings/projects"));
    expect(router.state.location.search).toEqual(search);
  },
);
