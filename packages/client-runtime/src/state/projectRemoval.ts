import { isListedThreadLineage, type OrchestrationV2RunStatus } from "@t3tools/contracts";

import {
  threadRuntimeIsActive,
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "./models.ts";

// Deleting a thread cancels its runs in these statuses (see the server's ThreadDeletion).
const CANCELLED_ON_DELETE = new Set<OrchestrationV2RunStatus>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

export function planProjectRemoval<
  Thread extends Pick<
    EnvironmentThreadShell,
    "environmentId" | "projectId" | "lineage" | "latestRun" | "runtime"
  >,
>(options: {
  readonly members: ReadonlyArray<
    Pick<EnvironmentProject, "id" | "environmentId" | "title" | "workspaceRoot"> & {
      readonly environmentLabel?: string | null;
    }
  >;
  /** Registrations to count threads for, stale duplicates included. Defaults to `members`. */
  readonly registrations?: ReadonlyArray<Pick<EnvironmentProject, "id" | "environmentId">>;
  readonly groupMemberCount: number;
  readonly hasOtherMembers: boolean;
  readonly displayName: string;
  readonly threads: ReadonlyArray<Thread>;
  /** The members' threads this client does not hold: older settled threads its shell left out. */
  readonly unloadedThreadCount?: number;
}) {
  const { members, groupMemberCount, hasOtherMembers, displayName, threads } = options;
  const projectKeys = new Set(
    (options.registrations ?? members).map((project) => `${project.environmentId}:${project.id}`),
  );
  const projectThreads = threads.filter((thread) =>
    projectKeys.has(`${thread.environmentId}:${thread.projectId}`),
  );
  // Side chats and subagents go with their parent but never show in thread lists.
  const threadCount =
    projectThreads.filter((thread) => isListedThreadLineage(thread.lineage)).length +
    (options.unloadedThreadCount ?? 0);
  // Counts every agent that stops, side chats and subagents included. The runtime follows the
  // run doing work, which can be an older one still running after a newer run was cancelled.
  const runningThreadCount = projectThreads.filter(
    (thread) =>
      threadRuntimeIsActive(thread.runtime) ||
      (thread.latestRun !== null && CANCELLED_ON_DELETE.has(thread.latestRun.status)),
  ).length;
  const isWholeGroup = members.length === groupMemberCount;
  const targetKind = hasOtherMembers || !isWholeGroup ? "checkout" : "project";
  const singleMember = members.length === 1 ? members[0]! : null;
  const targetLabel = singleMember?.title ?? displayName;
  const confirmationMessage = [
    threadCount > 0
      ? `Remove ${targetKind} "${targetLabel}" and delete its ${threadCount} thread${threadCount === 1 ? "" : "s"}?`
      : `Remove ${targetKind} "${targetLabel}"?`,
    ...(singleMember
      ? [
          `Path: ${singleMember.workspaceRoot}`,
          ...(singleMember.environmentLabel
            ? [`Environment: ${singleMember.environmentLabel}`]
            : []),
        ]
      : [`This removes ${members.length} grouped project entries.`]),
    ...(threadCount > 0
      ? [
          "Those threads and any archived threads are deleted from T3 Code. Provider session history is kept.",
        ]
      : ["Any archived threads are deleted from T3 Code. Provider session history is kept."]),
    ...(runningThreadCount > 0
      ? [`${runningThreadCount} running agent${runningThreadCount === 1 ? "" : "s"} will stop.`]
      : []),
    isWholeGroup && !hasOtherMembers
      ? "This removes only the project entries, not the files on disk."
      : "Other entries in this grouped project are unaffected.",
    "This action cannot be undone.",
  ].join("\n");

  return {
    projectThreads,
    threadCount,
    runningThreadCount,
    isWholeGroup,
    targetKind,
    confirmationMessage,
  };
}
