import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

// The summary scrolls only with the app's layout.
import "~/index.css";

import { act, fakeTimers, render } from "../../test/render";
import { RemoveProjectDialog } from "./RemoveProjectDialog";
import type {
  RemoveProjectBlocker,
  RemoveProjectFailure,
  RemoveProjectRequest,
} from "./RemoveProjectDialog.logic";

const request: RemoveProjectRequest = {
  name: "Acme",
  threadCount: 2,
  threadKeys: ["local:t1", "local:t2"],
  runningThreads: [],
  worktreeDeletion: null,
  keptWorktrees: [],
  worktreeNames: "machine",
  checkouts: [
    {
      key: "local:acme",
      location: "Local",
      machine: "this machine",
      worktreeName: "this machine",
      workspaceRoot: "/work/acme",
      worktreeRule: "keep",
      threadCount: 2,
    },
  ],
};

const failure: RemoveProjectFailure = {
  attempt: 1,
  title: "Failed to remove the project",
  cause: "Server unavailable",
  loss: "Some of its threads may already be deleted",
  advice: "Try again to finish",
};

const isRemoveChord = (event: KeyboardEvent) =>
  event.key === "Backspace" && event.shiftKey && event.metaKey;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function pressRemoveChord(repeat: boolean) {
  await act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Backspace",
        shiftKey: true,
        metaKey: true,
        repeat,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

describe("RemoveProjectDialog", () => {
  it("leaves Enter on Cancel and confirms only on a fresh press a moment after opening or widening", async () => {
    const onConfirm = vi.fn();
    const dialog = (shown: RemoveProjectRequest, failed: RemoveProjectFailure | null = null) => (
      <RemoveProjectDialog
        request={shown}
        blockedBy={null}
        pending={false}
        failure={failed}
        confirmShortcutLabel="⇧⌘⌫"
        confirmAriaKeyShortcuts="Shift+Meta+Backspace"
        isConfirmShortcut={isRemoveChord}
        settingsLink={null}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />
    );
    // The pause starts as the dialog opens, so the first render already needs the fake clock.
    using _timers = fakeTimers();
    await using screen = await render(dialog(request));
    // Assert synchronously: expect.element polls on timers this test fakes.
    await advance(50);
    expect(page.getByRole("button", { name: "Cancel" }).element()).toHaveFocus();
    const removeProject = page.getByRole("button", { name: "Remove project" }).element();
    expect(removeProject).toHaveAttribute("aria-disabled", "true");
    await pressRemoveChord(false);
    // A double click on whatever opened the dialog can land on Remove too.
    await act(() => (removeProject as HTMLButtonElement).click());
    expect(onConfirm).not.toHaveBeenCalled();
    await advance(450);
    expect(removeProject).not.toHaveAttribute("aria-disabled");
    // The chord may still be held down; its repeats must not confirm either.
    await pressRemoveChord(true);
    expect(onConfirm).not.toHaveBeenCalled();
    await pressRemoveChord(false);
    expect(onConfirm).toHaveBeenCalledOnce();

    // Checkouts that join widen what goes, so Remove pauses, for clicks too, and says so.
    const joined = [
      {
        key: "vps:acme",
        location: "vps",
        machine: "vps",
        worktreeName: "vps",
        workspaceRoot: "/srv/acme",
        worktreeRule: "keep",
        threadCount: 0,
      },
      {
        key: "mini:acme",
        location: "mini",
        machine: "mini",
        worktreeName: "mini",
        workspaceRoot: "/Users/me/acme",
        worktreeRule: "keep",
        threadCount: 0,
      },
    ] as const;
    await screen.rerender(dialog({ ...request, checkouts: [...request.checkouts, ...joined] }));
    const remove = page.getByRole("button", { name: "Remove all 3 checkouts" }).element();
    expect(page.getByText("Now removes all 3 checkouts.").element()).toBeVisible();
    expect(remove).toHaveAttribute("aria-disabled", "true");
    await act(() => (remove as HTMLButtonElement).click());
    await pressRemoveChord(false);
    expect(onConfirm).toHaveBeenCalledOnce();
    await advance(500);
    expect(remove).not.toHaveAttribute("aria-disabled");
    await pressRemoveChord(false);
    expect(onConfirm).toHaveBeenCalledTimes(2);

    // Confirming accepted them, so what a failed removal leaves is not news.
    await screen.rerender(dialog({ ...request, checkouts: joined }));
    expect(
      page.getByRole("button", { name: "Remove both checkouts" }).element(),
    ).not.toHaveAttribute("aria-disabled");
    expect(page.getByText(/Now removes/).query()).toBeNull();
    expect(page.getByText(/Now deletes/).query()).toBeNull();

    // A rule that now deletes a checkout's worktrees changes what goes, so Remove pauses and says so.
    const deleting = {
      ...request,
      checkouts: [{ ...joined[0], worktreeRule: "tracked-changes" }, joined[1]],
      worktreeDeletion: { certainty: "possible", keepWhen: "tracked-changes", only: ["vps"] },
    } satisfies RemoveProjectRequest;
    await screen.rerender(dialog(deleting));
    expect(page.getByText("Now deletes thread worktrees on vps, if any.").element()).toBeVisible();
    const removeBoth = page.getByRole("button", { name: "Remove both checkouts" }).element();
    expect(removeBoth).toHaveAttribute("aria-disabled", "true");
    await advance(500);
    expect(removeBoth).not.toHaveAttribute("aria-disabled");

    // A rule that then spares more is not news, though it still deletes more than was accepted.
    await screen.rerender(
      dialog({
        ...deleting,
        checkouts: [{ ...joined[0], worktreeRule: "uncommitted-changes" }, joined[1]],
        worktreeDeletion: { ...deleting.worktreeDeletion, keepWhen: "uncommitted-changes" },
      }),
    );
    expect(page.getByText("Now deletes thread worktrees on vps, if any.").element()).toBeVisible();
    expect(removeBoth).not.toHaveAttribute("aria-disabled");

    // A thread that starts running would be stopped too, so it counts as a change.
    await screen.rerender(
      dialog({ ...deleting, runningThreads: [{ key: "vps:new-thread", title: "New thread" }] }),
    );
    expect(page.getByText('Now stops "New thread".').element()).toBeVisible();
    expect(removeBoth).toHaveAttribute("aria-disabled", "true");
    await advance(500);

    // A new thread gets its real title later; the same thread is not news twice.
    await act(() => (removeBoth as HTMLButtonElement).click());
    const renamed = { key: "vps:new-thread", title: "Fix the login flow" };
    await screen.rerender(dialog({ ...deleting, runningThreads: [renamed] }));
    expect(page.getByText(/Now stops/).query()).toBeNull();
    expect(removeBoth).not.toHaveAttribute("aria-disabled");

    // Another thread that shares a running thread's title is still another thread to stop.
    const retry = { ...renamed, key: "vps:retry" };
    await screen.rerender(dialog({ ...deleting, runningThreads: [renamed, retry] }));
    expect(page.getByText('Now stops "Fix the login flow".').element()).toBeVisible();
    expect(removeBoth).toHaveAttribute("aria-disabled", "true");
    await advance(500);

    // One of two new threads finishing leaves less to stop, so the pause neither restarts nor ends.
    const docs = { key: "vps:docs", title: "Update the docs" };
    await screen.rerender(dialog({ ...deleting, runningThreads: [renamed, retry, docs] }));
    expect(page.getByText("Now stops 2 more unfinished threads.").element()).toBeVisible();
    await advance(300);
    await screen.rerender(dialog({ ...deleting, runningThreads: [renamed, docs] }));
    expect(page.getByText('Now stops "Update the docs".').element()).toBeVisible();
    expect(removeBoth).toHaveAttribute("aria-disabled", "true");
    await advance(200);
    expect(removeBoth).not.toHaveAttribute("aria-disabled");

    // A thread that arrives, one that finished elsewhere, would be deleted too, so it's news.
    await act(() => (removeBoth as HTMLButtonElement).click());
    const vps = deleting.checkouts[0]!;
    const mini = deleting.checkouts[1]!;
    const arrived = {
      ...deleting,
      runningThreads: [renamed, docs],
      threadCount: request.threadCount + 1,
      threadKeys: [...request.threadKeys, "vps:arrived"],
      checkouts: [{ ...vps, threadCount: 1 }, mini],
    };
    await screen.rerender(dialog(arrived));
    expect(page.getByText("Now deletes 1 more thread.").element()).toBeVisible();
    expect(removeBoth).toHaveAttribute("aria-disabled", "true");
    await advance(500);

    // An older thread the list loads was counted all along, so it isn't another one.
    const loaded = { ...arrived, threadKeys: [...arrived.threadKeys, "vps:older"] };
    await screen.rerender(dialog(loaded));
    expect(page.getByText("Now deletes 1 more thread.").element()).toBeVisible();
    expect(removeBoth).not.toHaveAttribute("aria-disabled");

    // One that arrives running is named as one that stops. Finishing changes the words, but
    // nothing more goes, so Remove doesn't pause again.
    await act(() => (removeBoth as HTMLButtonElement).click());
    const arrivedRunning = { key: "vps:imported", title: "Imported work" };
    const imported = {
      ...loaded,
      threadCount: request.threadCount + 2,
      threadKeys: [...loaded.threadKeys, "vps:imported"],
      checkouts: [{ ...vps, threadCount: 2 }, mini],
    };
    await screen.rerender(dialog({ ...imported, runningThreads: [renamed, docs, arrivedRunning] }));
    expect(page.getByText('Now stops "Imported work".').element()).toBeVisible();
    expect(page.getByText(/Now deletes/).query()).toBeNull();
    expect(removeBoth).toHaveAttribute("aria-disabled", "true");
    await advance(500);
    await screen.rerender(dialog(imported));
    expect(page.getByText("Now deletes 1 more thread.").element()).toBeVisible();
    expect(removeBoth).not.toHaveAttribute("aria-disabled");

    // A failed try takes threads with the checkout it removed, and what arrives after it counts
    // from there, even while the list still shows that checkout.
    await act(() => (removeBoth as HTMLButtonElement).click());
    await screen.rerender(dialog(imported, failure));
    expect(removeBoth).not.toHaveAttribute("aria-disabled");
    const left = { ...imported, threadCount: 0, threadKeys: [], checkouts: [mini] };
    await screen.rerender(dialog(left, failure));
    const removeLeft = page.getByRole("button", { name: "Remove project" }).element();
    expect(removeLeft).not.toHaveAttribute("aria-disabled");
    await screen.rerender(
      dialog(
        {
          ...left,
          threadCount: 1,
          threadKeys: ["mini:late"],
          checkouts: [{ ...mini, threadCount: 1 }],
        },
        failure,
      ),
    );
    expect(page.getByText("Now deletes 1 more thread.").element()).toBeVisible();
    expect(removeLeft).toHaveAttribute("aria-disabled", "true");
  });

  it("names the offline machine and confirms only a moment after it connects", async () => {
    const onConfirm = vi.fn();
    const dialog = (blockedBy: RemoveProjectBlocker | null) => (
      <RemoveProjectDialog
        request={request}
        blockedBy={blockedBy}
        pending={false}
        failure={null}
        confirmShortcutLabel="⇧⌘⌫"
        confirmAriaKeyShortcuts="Shift+Meta+Backspace"
        isConfirmShortcut={isRemoveChord}
        settingsLink={null}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />
    );
    await using screen = await render(
      dialog({ reason: "offline", machines: ["vps"], someRemovable: false }),
    );

    await expect
      .element(page.getByText("vps isn't connected. Connect it to remove this project."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Remove project" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await pressRemoveChord(false);
    expect(onConfirm).not.toHaveBeenCalled();

    // Connecting can change the summary, so Remove pauses then too.
    using _timers = fakeTimers();
    await screen.rerender(dialog(null));
    // Assert synchronously: expect.element polls on timers this test fakes.
    expect(page.getByRole("button", { name: "Remove project" }).element()).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await pressRemoveChord(false);
    expect(onConfirm).not.toHaveBeenCalled();
    await advance(500);
    await pressRemoveChord(false);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  // regression: a focused control that stopped taking focus dropped it to the page, where the
  // remove shortcut reaches the browser's own binding
  it("keeps focus on a control that stops being usable while focused", async () => {
    const onFollow = vi.fn();
    const dialog = (count: number, blockedBy: RemoveProjectBlocker | null) => (
      <RemoveProjectDialog
        request={{
          ...request,
          checkouts: Array.from({ length: count }, (_, index) => ({
            key: `local:acme-${index}`,
            location: "Local",
            machine: "this machine",
            worktreeName: "this machine",
            workspaceRoot: `/work/acme-${index}`,
            worktreeRule: "keep",
            threadCount: 0,
          })),
        }}
        blockedBy={blockedBy}
        pending={false}
        failure={null}
        confirmShortcutLabel="⇧⌘⌫"
        confirmAriaKeyShortcuts="Shift+Meta+Backspace"
        isConfirmShortcut={isRemoveChord}
        settingsLink={{ projectKey: "acme", onFollow }}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    );
    // Short enough that nine checkouts scroll.
    await page.viewport(1280, 420);
    await using screen = await render(dialog(9, null));
    const effects = () =>
      document.querySelector("[data-slot=alert-dialog-description] ul")!
        .parentElement as HTMLElement;
    await expect.poll(() => effects().getAttribute("tabindex")).toBe("0");
    await act(() => effects().focus());
    await screen.rerender(dialog(1, null));
    // The size observer has measured once the bottom fade is gone.
    await expect
      .poll(() => effects().style.getPropertyValue("--fade-bottom"))
      .toBe("calc(100% - 0px)");
    expect(effects()).toHaveAttribute("tabindex", "0");
    expect(document.activeElement).toBe(effects());

    const remove = page.getByRole("button", { name: "Remove project" }).element();
    await act(() => (remove as HTMLButtonElement).focus());
    await screen.rerender(
      dialog(1, { reason: "offline", machines: ["vps"], someRemovable: false }),
    );
    expect(remove).toHaveAttribute("aria-disabled", "true");
    expect(remove).not.toHaveAttribute("disabled");
    expect(document.activeElement).toBe(remove);

    // The Settings link moves from the note to the amber line as a machine drops, and back.
    const popup = () => document.querySelector("[data-slot=alert-dialog-popup]")!;
    const link = () => page.getByRole("link", { name: "Settings → Projects" }).element();
    const vpsOffline = { reason: "offline", machines: ["vps"], someRemovable: true } as const;
    await screen.rerender(dialog(2, null));
    await act(() => (link() as HTMLElement).focus());
    await screen.rerender(dialog(2, null));
    expect(document.activeElement).toBe(link());
    await screen.rerender(dialog(2, vpsOffline));
    expect(document.activeElement).toBe(popup());
    await act(() => (link() as HTMLElement).focus());
    await screen.rerender(dialog(2, null));
    expect(document.activeElement).toBe(popup());

    // A click with a modifier opens a tab or nothing, so it leaves the dialog where it is.
    window.addEventListener("click", (event) => event.preventDefault(), { once: true });
    await act(() =>
      link().dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
      ),
    );
    expect(onFollow).not.toHaveBeenCalled();
  });

  // regression: in a window too short for the summary, a checkout that joined and a failure both
  // landed below the fold, and a press during the opening pause scrolled the effects away
  it("scrolls a short window's summary only to what is new", async () => {
    const dialog = (
      count: number,
      blockedBy: RemoveProjectBlocker | null,
      failed: RemoveProjectFailure | null = null,
    ) => (
      <RemoveProjectDialog
        request={{
          ...request,
          name: "pingdotgg/t3code-marketing-site-and-docs-experiments-26",
          checkouts: Array.from({ length: count }, (_, index) => ({
            key: `local:acme-${index}`,
            location: "Local",
            machine: "this machine",
            worktreeName: "this machine",
            workspaceRoot: `/work/acme-${index}`,
            worktreeRule: "keep",
            threadCount: 0,
          })),
        }}
        blockedBy={blockedBy}
        pending={false}
        failure={failed}
        confirmShortcutLabel="⇧⌘⌫"
        confirmAriaKeyShortcuts="Shift+Meta+Backspace"
        isConfirmShortcut={isRemoveChord}
        settingsLink={null}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    );
    // Shorter than the desktop app's smallest window, so the whole body scrolls throughout.
    await page.viewport(400, 320);
    await using screen = await render(
      dialog(4, { reason: "loading", machines: ["vps"], someRemovable: true }),
    );
    const body = () =>
      document.querySelector("[data-slot=alert-dialog-description]")!
        .firstElementChild as HTMLElement;
    // The whole body scrolls once it has measured the window as too short.
    await expect.poll(() => body().getAttribute("tabindex")).toBe("0");
    await pressRemoveChord(false);
    await expect.element(page.getByText("vps is still loading…")).toBeInViewport();

    // Fake timers stop expect.element from polling, so what shows is measured directly.
    const shows = (text: string) => {
      const view = body().getBoundingClientRect();
      const { top, bottom } = page.getByText(text).element().getBoundingClientRect();
      return top >= view.top - 1 && bottom <= view.bottom + 1;
    };
    await act(() => body().scrollTo({ top: 0 }));
    using _timers = fakeTimers();
    // The pause after a wait has nothing new to say, so a press leaves the effects where they are.
    await screen.rerender(dialog(4, null));
    await pressRemoveChord(false);
    expect(body().scrollTop).toBe(0);
    await advance(500);

    await screen.rerender(dialog(5, null));
    expect(shows("Now removes all 5 checkouts.")).toBe(true);

    await act(() => body().scrollTo({ top: 0 }));
    await screen.rerender(dialog(5, null, failure));
    expect(shows(failure.title)).toBe(true);
  });

  // regression: an error that made a short window's body start scrolling stayed below the fold
  it("brings a failure into view when it makes a short window's body scroll", async () => {
    const dialog = (failed: RemoveProjectFailure | null) => (
      <RemoveProjectDialog
        request={{
          ...request,
          // Enough paths that, once the body scrolls, the error starts below the fold.
          checkouts: Array.from({ length: 5 }, (_, index) => ({
            ...request.checkouts[0]!,
            key: `local:acme-${index}`,
            workspaceRoot: `/work/acme-${index}`,
          })),
        }}
        blockedBy={null}
        pending={false}
        failure={failed}
        confirmShortcutLabel="⇧⌘⌫"
        confirmAriaKeyShortcuts="Shift+Meta+Backspace"
        isConfirmShortcut={isRemoveChord}
        settingsLink={null}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    );
    // The desktop app's smallest window, with room for everything until the error arrives.
    await page.viewport(400, 360);
    await using screen = await render(dialog(null));
    const body = () =>
      document.querySelector("[data-slot=alert-dialog-description]")!
        .firstElementChild as HTMLElement;
    await expect.element(page.getByText("This can't be undone.")).toBeInViewport();
    expect(body()).not.toHaveAttribute("tabindex");

    await screen.rerender(dialog(failure));
    await expect.poll(() => body().getAttribute("tabindex")).toBe("0");
    await expect.element(page.getByText(failure.title)).toBeInViewport();
  });
});
