import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { isMacPlatform } from "../lib/utils";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { makeThreadFixture } from "../test-fixtures";
import type { Project, Thread } from "../types";
import { CommandPalette } from "./CommandPalette";

const entities = vi.hoisted(() => ({
  projects: [] as ReadonlyArray<Project>,
  threads: [] as ReadonlyArray<Thread>,
  listeners: new Set<() => void>(),
}));
vi.mock("../state/entities", async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    entities.listeners.add(listener);
    return () => entities.listeners.delete(listener);
  };
  return {
    ...(await original<typeof import("../state/entities")>()),
    useProjects: () => useSyncExternalStore(subscribe, () => entities.projects),
    useVisibleThreadShells: () => entities.threads,
  };
});
// The palette offers removal only on machines this connection may change.
vi.mock("../hooks/useProjectGroupUpdate", async (original) => ({
  ...(await original<typeof import("../hooks/useProjectGroupUpdate")>()),
  useProjectGroupRemoval: () => ({
    canRemoveProjectGroup: () => true,
    removeProjectMembers: async () => "removed" as const,
  }),
}));

function setup(state: { projects?: ReadonlyArray<Project>; threads?: ReadonlyArray<Thread> } = {}) {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  entities.projects = state.projects ?? [];
  entities.threads = state.threads ?? [];
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

  // regression: the first row is already Base UI's highlight, so hovering it reported nothing
  it("highlights the first project in New thread in... when the pointer moves onto it", async () => {
    setup({ projects: projectsTitled(["Acme", "Beta"]) });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });
    const first = page.getByRole("option").first();
    await expect.element(first).not.toHaveAttribute("data-active");
    await userEvent.hover(first);

    await expect.element(first).toHaveAttribute("data-active");
  });

  // regression: Base UI falls back to the first row, which the remove shortcut then targeted
  it("waits for a move before removing again after the last project leaves the list", async () => {
    setup({ projects: projectsTitled(["Acme", "Beta", "Gamma"]) });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    const removeChord = isMacPlatform(navigator.platform)
      ? "{Shift>}{Meta>}{Backspace}{/Meta}{/Shift}"
      : "{Shift>}{Control>}{Backspace}{/Control}{/Shift}";

    openCommandPalette({ open: "new-thread-in" });
    await expect.element(page.getByRole("option")).toHaveLength(3);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    await expect.element(page.getByRole("option").nth(2)).toHaveAttribute("data-active");

    await act(() => {
      entities.projects = entities.projects.slice(0, 2);
      for (const listener of entities.listeners) listener();
    });
    await expect.element(page.getByRole("option")).toHaveLength(2);
    // Nothing is highlighted, so no row shows its buttons and the shortcut has no target.
    expect(document.querySelectorAll("[data-highlighted], [data-active]")).toHaveLength(0);
    await userEvent.keyboard(removeChord);
    expect(page.getByRole("alertdialog").elements()).toHaveLength(0);

    // Up from no highlight lands on the new last row.
    await userEvent.keyboard("{ArrowUp}");
    await userEvent.keyboard(removeChord);
    await vi.waitFor(() =>
      expect(document.querySelector("[role=alertdialog]")?.textContent).toContain('Remove "Beta"'),
    );
  });
});

function projectsTitled(titles: ReadonlyArray<string>): ReadonlyArray<Project> {
  const environmentId = EnvironmentId.make("local");
  return titles.map((title) => ({
    id: ProjectId.make(title.toLowerCase()),
    environmentId,
    title,
    workspaceRoot: `/work/${title.toLowerCase()}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    scripts: [],
  }));
}
