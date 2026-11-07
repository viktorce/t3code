import type { ProjectRemovalFailure } from "@t3tools/client-runtime/state/projects";
import type { WorktreeCleanupRules, WorktreeKeepWhen } from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";

export interface RemoveProjectRequest {
  readonly name: string;
  readonly threadCount: number;
  /** Every thread of the project this client holds, so one that arrives running is named once. */
  readonly threadKeys: ReadonlyArray<string>;
  /** The listed threads that removal stops; the key stays while a new thread gets its title. */
  readonly runningThreads: ReadonlyArray<RunningThread>;
  /** What the storage rules do to its thread worktrees; null when no checkout's rules delete them. */
  readonly worktreeDeletion: {
    /** "possible" when none of the threads this client holds has one, since archived threads can. */
    readonly certainty: "known" | "possible";
    /** The weakest protection among the checkouts whose rules delete them. */
    readonly keepWhen: WorktreeKeepWhen;
    /** The checkouts whose rules delete them, named only when other checkouts keep theirs. */
    readonly only: ReadonlyArray<string> | null;
  } | null;
  /** The checkouts that keep the worktrees their threads have. */
  readonly keptWorktrees: ReadonlyArray<string>;
  /** Checkouts are named by machine, or by folder when one machine has them on both sides. */
  readonly worktreeNames: "machine" | "folder";
  readonly checkouts: ReadonlyArray<{
    readonly key: string;
    readonly location: string;
    /** How a sentence names the machine, such as "this machine". */
    readonly machine: string;
    /** How the worktree lines name it: its machine, or its folder when one machine is on both sides. */
    readonly worktreeName: string;
    readonly workspaceRoot: string;
    readonly worktreeRule: WorktreeRule;
    /** Its threads, held or not, so older ones the list loads aren't mistaken for new ones. */
    readonly threadCount: number;
  }>;
}

export interface RunningThread {
  readonly key: string;
  readonly title: string;
}

/** What a checkout's storage rule does to its thread worktrees on removal. */
export type WorktreeRule = "keep" | "unknown" | WorktreeKeepWhen;

/** A failed try; `attempt` changes with each one. */
export interface RemoveProjectFailure extends ProjectRemovalFailure {
  readonly attempt: number;
}

/** Why confirming has to wait: machines that are offline, deny this connection, or still load. */
export interface RemoveProjectBlocker {
  readonly reason: "offline" | "denied" | "loading";
  readonly machines: ReadonlyArray<string>;
  /** Some checkout's machine takes changes, now or once it loads, so Settings can remove it alone. */
  readonly someRemovable: boolean;
}

export interface RemoveProjectCheckout {
  readonly key: string;
  /** How the location label names the machine, such as "Local". */
  readonly location: string;
  /** How a sentence names the machine, such as "this machine". */
  readonly machine: string;
  readonly workspaceRoot: string;
  /** The checkout's worktree cleanup rule, or null while its machine's settings are unknown. */
  readonly cleanup: Pick<WorktreeCleanupRules, "worktreeOnDelete" | "worktreeKeepWhen"> | null;
  readonly hasWorktrees: boolean;
  readonly connection: "ready" | RemoveProjectBlocker["reason"];
  readonly threadCount: number;
}

const KEEP_WHEN_STRENGTH: Record<WorktreeKeepWhen, number> = {
  "tracked-changes": 0,
  "uncommitted-changes": 1,
  "any-local-files": 2,
};

/** Kept or unknown spares the most; a deleting rule ranks by what it spares. */
function protectionOf(rule: WorktreeRule) {
  return rule === "keep" || rule === "unknown" ? 3 : KEEP_WHEN_STRENGTH[rule];
}

/** Whether a checkout's rule now deletes more of its worktrees: deletion turned on, or spares less. */
export function deletesMoreWorktrees(before: WorktreeRule, after: WorktreeRule): boolean {
  return protectionOf(after) < protectionOf(before);
}

type Cleanup = NonNullable<RemoveProjectCheckout["cleanup"]>;

/** The rule to show when either of two may apply: it deletes if either does, sparing what both spare. */
export function eitherCleanupRule(left: Cleanup, right: Cleanup): Cleanup {
  const deleting = [left, right].filter((rule) => rule.worktreeOnDelete);
  return (
    deleting.toSorted(
      (a, b) => KEEP_WHEN_STRENGTH[a.worktreeKeepWhen] - KEEP_WHEN_STRENGTH[b.worktreeKeepWhen],
    )[0] ?? left
  );
}

function machinesOf(checkouts: ReadonlyArray<RemoveProjectCheckout>) {
  return [...new Set(checkouts.map((checkout) => checkout.machine))];
}

export function buildRemoveProjectRequest(input: {
  readonly name: string;
  readonly threadCount: number;
  readonly threadKeys: ReadonlyArray<string>;
  readonly runningThreads: ReadonlyArray<RunningThread>;
  readonly checkouts: ReadonlyArray<RemoveProjectCheckout>;
}): RemoveProjectRequest {
  // By machine, then path, so a repository's root comes before checkouts inside it.
  const checkouts = input.checkouts.toSorted(
    (left, right) =>
      left.location.localeCompare(right.location) ||
      left.workspaceRoot.localeCompare(right.workspaceRoot),
  );
  const deleting = checkouts.flatMap((checkout) =>
    checkout.cleanup?.worktreeOnDelete
      ? [{ checkout, keepWhen: checkout.cleanup.worktreeKeepWhen }]
      : [],
  );
  const keepWhen = deleting
    .map((entry) => entry.keepWhen)
    .toSorted((left, right) => KEEP_WHEN_STRENGTH[left] - KEEP_WHEN_STRENGTH[right])[0];
  const deletingCheckouts = deleting.map((entry) => entry.checkout);
  const keepingCheckouts = checkouts.filter((checkout) => !deletingCheckouts.includes(checkout));
  const keepingMachines = machinesOf(keepingCheckouts);
  const worktreeNames = machinesOf(deletingCheckouts).some((machine) =>
    keepingMachines.includes(machine),
  )
    ? "folder"
    : "machine";
  const folders = checkouts.map((checkout) => fileBasename(checkout.workspaceRoot));
  const paths = checkouts.map((checkout) => checkout.workspaceRoot);
  const isUnique = (values: ReadonlyArray<string>, value: string) =>
    values.filter((candidate) => candidate === value).length === 1;
  // Folders that share a name fall back to their paths, and a path two machines share to both.
  const nameOf = (checkout: RemoveProjectCheckout) =>
    worktreeNames === "machine"
      ? checkout.machine
      : isUnique(folders, fileBasename(checkout.workspaceRoot))
        ? fileBasename(checkout.workspaceRoot)
        : isUnique(paths, checkout.workspaceRoot)
          ? checkout.workspaceRoot
          : `${checkout.workspaceRoot} on ${checkout.machine}`;
  const namesOf = (checkouts: ReadonlyArray<RemoveProjectCheckout>) => [
    ...new Set(checkouts.map(nameOf)),
  ];
  return {
    name: input.name,
    threadCount: input.threadCount,
    threadKeys: input.threadKeys,
    runningThreads: input.runningThreads,
    // The storage rule also deletes worktrees of archived threads this client cannot see.
    worktreeDeletion:
      keepWhen === undefined
        ? null
        : {
            certainty: deletingCheckouts.some((checkout) => checkout.hasWorktrees)
              ? "known"
              : "possible",
            keepWhen,
            only: keepingCheckouts.length === 0 ? null : namesOf(deletingCheckouts),
          },
    // A checkout whose rule this client doesn't know is in neither list: no promise either way.
    keptWorktrees: namesOf(
      keepingCheckouts.filter((checkout) => checkout.cleanup !== null && checkout.hasWorktrees),
    ),
    worktreeNames,
    checkouts: checkouts.map((checkout) => ({
      key: checkout.key,
      location: checkout.location,
      machine: checkout.machine,
      worktreeName: nameOf(checkout),
      workspaceRoot: checkout.workspaceRoot,
      worktreeRule:
        checkout.cleanup === null
          ? "unknown"
          : checkout.cleanup.worktreeOnDelete
            ? checkout.cleanup.worktreeKeepWhen
            : "keep",
      threadCount: checkout.threadCount,
    })),
  };
}

/** A refusal comes first, since connecting can't help it; then offline machines, then loading ones. */
export function findRemoveProjectBlocker(
  checkouts: ReadonlyArray<RemoveProjectCheckout>,
): RemoveProjectBlocker | null {
  for (const reason of ["denied", "offline", "loading"] as const) {
    const blocked = checkouts.filter((checkout) => checkout.connection === reason);
    if (blocked.length > 0) {
      return {
        reason,
        machines: machinesOf(blocked),
        someRemovable: checkouts.some(
          (checkout) => checkout.connection === "ready" || checkout.connection === "loading",
        ),
      };
    }
  }
  return null;
}
