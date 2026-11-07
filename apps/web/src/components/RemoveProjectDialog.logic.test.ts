import type { WorktreeKeepWhen } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildRemoveProjectRequest,
  deletesMoreWorktrees,
  eitherCleanupRule,
  findRemoveProjectBlocker,
  type RemoveProjectCheckout,
} from "./RemoveProjectDialog.logic";

function checkout(
  machine: string,
  overrides: Partial<RemoveProjectCheckout> = {},
): RemoveProjectCheckout {
  return {
    key: `${machine}:${overrides.workspaceRoot ?? "/work/acme"}`,
    location: machine === "this machine" ? "Local" : machine,
    machine,
    workspaceRoot: "/work/acme",
    cleanup: { worktreeOnDelete: false, worktreeKeepWhen: "uncommitted-changes" },
    hasWorktrees: false,
    connection: "ready",
    threadCount: 0,
    ...overrides,
  };
}

const deletes = (worktreeKeepWhen: WorktreeKeepWhen) => ({
  cleanup: { worktreeOnDelete: true, worktreeKeepWhen },
});

describe("buildRemoveProjectRequest", () => {
  it.each([
    {
      name: "keeps worktrees when no rule deletes them",
      checkouts: [checkout("this machine", { hasWorktrees: true })],
      worktreeDeletion: null,
      keptWorktrees: ["this machine"],
      worktreeNames: "machine",
    },
    {
      name: "says worktrees go when a deleting checkout has one",
      checkouts: [
        checkout("this machine", { ...deletes("uncommitted-changes"), hasWorktrees: true }),
      ],
      worktreeDeletion: { certainty: "known", keepWhen: "uncommitted-changes", only: null },
      keptWorktrees: [],
      worktreeNames: "machine",
    },
    {
      name: "hedges when only archived threads could have worktrees",
      checkouts: [checkout("this machine", deletes("uncommitted-changes"))],
      worktreeDeletion: { certainty: "possible", keepWhen: "uncommitted-changes", only: null },
      keptWorktrees: [],
      worktreeNames: "machine",
    },
    {
      name: "names the machines on each side when the rules differ by machine",
      checkouts: [
        checkout("vps", deletes("any-local-files")),
        checkout("this machine", { hasWorktrees: true }),
      ],
      worktreeDeletion: { certainty: "possible", keepWhen: "any-local-files", only: ["vps"] },
      keptWorktrees: ["this machine"],
      worktreeNames: "machine",
    },
    {
      name: "names folders when one machine has checkouts on both sides",
      checkouts: [
        checkout("this machine", { ...deletes("uncommitted-changes"), workspaceRoot: "/work/a" }),
        checkout("this machine", { hasWorktrees: true, workspaceRoot: "/work/b" }),
        checkout("vps", { ...deletes("uncommitted-changes"), workspaceRoot: "/srv/b" }),
      ],
      worktreeDeletion: {
        certainty: "possible",
        keepWhen: "uncommitted-changes",
        only: ["a", "/srv/b"],
      },
      keptWorktrees: ["/work/b"],
      worktreeNames: "folder",
    },
    {
      name: "adds the machine when two machines share a path",
      checkouts: [
        checkout("this machine", deletes("uncommitted-changes")),
        checkout("this machine", { workspaceRoot: "/work/acme2" }),
        checkout("mac-mini", { hasWorktrees: true }),
      ],
      worktreeDeletion: {
        certainty: "possible",
        keepWhen: "uncommitted-changes",
        only: ["/work/acme on this machine"],
      },
      keptWorktrees: ["/work/acme on mac-mini"],
      worktreeNames: "folder",
    },
    {
      name: "promises only the weakest protection among deleting checkouts",
      checkouts: [
        checkout("vps", deletes("any-local-files")),
        checkout("mac-mini", { ...deletes("tracked-changes"), hasWorktrees: true }),
      ],
      worktreeDeletion: { certainty: "known", keepWhen: "tracked-changes", only: null },
      keptWorktrees: [],
      worktreeNames: "machine",
    },
    {
      name: "promises nothing about worktrees whose rule is unknown",
      checkouts: [checkout("vps", { cleanup: null, hasWorktrees: true })],
      worktreeDeletion: null,
      keptWorktrees: [],
      worktreeNames: "machine",
    },
  ] as const)("$name", ({ checkouts, worktreeDeletion, keptWorktrees, worktreeNames }) => {
    const request = buildRemoveProjectRequest({
      name: "Acme",
      threadCount: 0,
      threadKeys: [],
      runningThreads: [],
      checkouts,
    });
    expect(request.worktreeDeletion).toEqual(worktreeDeletion);
    expect(request.keptWorktrees).toEqual(keptWorktrees);
    expect(request.worktreeNames).toBe(worktreeNames);
  });
});

describe("deletesMoreWorktrees", () => {
  it.each([
    ["keep", "tracked-changes", true],
    ["unknown", "any-local-files", true],
    ["uncommitted-changes", "tracked-changes", true],
    ["tracked-changes", "uncommitted-changes", false],
    ["any-local-files", "keep", false],
    ["keep", "unknown", false],
    ["uncommitted-changes", "uncommitted-changes", false],
  ] as const)("from %s to %s is %s", (before, after, expected) => {
    expect(deletesMoreWorktrees(before, after)).toBe(expected);
  });
});

describe("eitherCleanupRule", () => {
  const keeps = { worktreeOnDelete: false, worktreeKeepWhen: "tracked-changes" } as const;
  const deletesUnless = (worktreeKeepWhen: WorktreeKeepWhen) =>
    ({ worktreeOnDelete: true, worktreeKeepWhen }) as const;
  it.each([
    ["keeps only if both keep", keeps, keeps, keeps],
    [
      "deletes if the first does",
      deletesUnless("any-local-files"),
      keeps,
      deletesUnless("any-local-files"),
    ],
    [
      "deletes if the second does",
      keeps,
      deletesUnless("uncommitted-changes"),
      deletesUnless("uncommitted-changes"),
    ],
    [
      "spares only what both spare",
      deletesUnless("any-local-files"),
      deletesUnless("tracked-changes"),
      deletesUnless("tracked-changes"),
    ],
  ] as const)("%s", (_case, left, right, expected) => {
    expect(eitherCleanupRule(left, right)).toEqual(expected);
  });
});

describe("findRemoveProjectBlocker", () => {
  it("names denied machines before offline ones, and offline before loading ones", () => {
    const checkouts = [
      checkout("mac-mini", { connection: "loading" }),
      checkout("vps", { connection: "offline" }),
      checkout("vps", { connection: "offline", workspaceRoot: "/work/other" }),
      checkout("work", { connection: "denied" }),
    ];
    expect(findRemoveProjectBlocker(checkouts)).toEqual({
      reason: "denied",
      machines: ["work"],
      someRemovable: true,
    });
    expect(findRemoveProjectBlocker(checkouts.slice(0, 3))).toEqual({
      reason: "offline",
      machines: ["vps"],
      someRemovable: true,
    });
    expect(findRemoveProjectBlocker(checkouts.slice(0, 1))).toEqual({
      reason: "loading",
      machines: ["mac-mini"],
      someRemovable: true,
    });
    expect(findRemoveProjectBlocker([checkout("this machine")])).toBeNull();
    // Settings can't remove a single checkout either when no machine takes changes.
    expect(findRemoveProjectBlocker(checkouts.slice(1))).toMatchObject({ someRemovable: false });
  });
});
