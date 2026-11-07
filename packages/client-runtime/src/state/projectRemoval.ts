import { isListedThreadLineage, ProjectMutationError } from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";
import * as Schema from "effect/Schema";

import type { EnvironmentPresentation } from "../connection/presentation.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import {
  threadRuntimeCanArchive,
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "./models.ts";

const isProjectMutationError = Schema.is(ProjectMutationError);

/** Machine names keep their own case; only "this machine" opens a sentence in lower case. */
function sentenceStart(machine: string) {
  return machine.startsWith("this ") ? `T${machine.slice(1)}` : machine;
}

/** A removal that fails this way never left this client, because the machine isn't connected. */
export const isProjectRemovalUnsent = Schema.is(EnvironmentRpcUnavailableError);

/** A removal that fails this way already happened elsewhere; older servers do not say so. */
export function isProjectNotFoundError(error: unknown): boolean {
  return isProjectMutationError(error) && error.reason === "not-found";
}

/** Why a removal stopped, what may already be gone, and what to do; each part may be absent. */
export interface ProjectRemovalFailure {
  readonly title: string;
  readonly cause: string | null;
  readonly loss: string | null;
  readonly advice: string | null;
}

/** The failure as sentences, leaving out what the view around it already says. */
export function projectRemovalFailureText(
  failure: ProjectRemovalFailure,
  omit: { readonly cause?: boolean; readonly advice?: boolean } = {},
): string {
  return [omit.cause ? null : failure.cause, failure.loss, omit.advice ? null : failure.advice]
    .filter((sentence) => sentence !== null)
    .map((sentence) => (/[.!?]$/.test(sentence) ? sentence : `${sentence}.`))
    .join(" ");
}

/**
 * Names a checkout by title, then machine, then folder, or its path when folders repeat too. A view
 * that already names the project, such as the removal dialog, names the checkout without it.
 */
export function projectRemovalTarget<
  TMember extends Pick<EnvironmentProject, "title" | "workspaceRoot">,
>(
  member: TMember,
  members: ReadonlyArray<TMember>,
  machineOf: (member: TMember) => string,
  { projectNamed = false }: { readonly projectNamed?: boolean } = {},
) {
  if (members.length === 1) return projectNamed ? "the project" : `"${member.title}"`;
  const machine = machineOf(member);
  const twins = members.filter(
    (other) => (projectNamed || other.title === member.title) && machineOf(other) === machine,
  );
  if (twins.length === 1) {
    return projectNamed ? `the checkout on ${machine}` : `"${member.title}" on ${machine}`;
  }
  const folder = fileBasename(member.workspaceRoot);
  const place =
    twins.filter((other) => fileBasename(other.workspaceRoot) === folder).length === 1
      ? folder
      : member.workspaceRoot;
  return projectNamed
    ? `the ${place} checkout on ${machine}`
    : `"${member.title}" (${place}) on ${machine}`;
}

/**
 * Whether a checkout's machine can take its removal now. A refused grant comes first, since
 * connecting can't help it. A session that hasn't loaded, like settings or threads that haven't,
 * only needs a moment; the confirmation counts those threads.
 */
export function projectRemovalReadiness(
  environment: Pick<EnvironmentPresentation, "connection" | "serverConfig"> | null | undefined,
  scope: "granted" | "denied" | "unknown",
  /** Whether its threads reflect the server now, not a cache or a resync in flight. */
  threadsLive: boolean,
): "ready" | "loading" | "offline" | "denied" {
  if (scope === "denied") return "denied";
  if (environment?.connection.phase !== "connected") return "offline";
  return scope === "granted" && environment.serverConfig !== null && threadsLive
    ? "ready"
    : "loading";
}

/** A removal refused before it starts, because a machine isn't ready: why, and what to do. */
export function projectRemovalRefusal(
  title: string,
  readiness: "loading" | "offline" | "denied",
  machine: string,
): ProjectRemovalFailure {
  if (readiness === "denied") {
    return {
      title,
      cause: `This connection can't change projects on ${machine}`,
      loss: null,
      advice: null,
    };
  }
  return readiness === "loading"
    ? {
        title,
        cause: `${sentenceStart(machine)} is still loading`,
        loss: null,
        advice: "Try again in a moment",
      }
    : { title, cause: null, loss: null, advice: `Connect ${machine} and try again` };
}

/**
 * Why these checkouts can't be removed yet, naming each machine that holds them up, or null. A grant
 * outlives its connection, so an offline machine's checkouts would otherwise look removable.
 */
export function projectRemovalWait<TMember>(
  members: ReadonlyArray<TMember>,
  readinessOf: (member: TMember) => "ready" | "loading" | "offline" | "denied",
  machineOf: (member: TMember) => string,
): string | null {
  return projectWait(
    members,
    readinessOf,
    machineOf,
    members.length === 1 ? "remove it" : "remove them",
  );
}

/** Why a change to every checkout, such as a rename or a pin, can't run yet, or null. */
export function projectChangeWait<TMember>(
  members: ReadonlyArray<TMember>,
  readinessOf: (member: TMember) => "ready" | "loading" | "offline" | "denied",
  machineOf: (member: TMember) => string,
): string | null {
  return projectWait(members, readinessOf, machineOf, "change this project");
}

function projectWait<TMember>(
  members: ReadonlyArray<TMember>,
  readinessOf: (member: TMember) => "ready" | "loading" | "offline" | "denied",
  machineOf: (member: TMember) => string,
  goal: string,
): string | null {
  const machinesThatAre = (readiness: "loading" | "offline" | "denied") => [
    ...new Set(members.filter((member) => readinessOf(member) === readiness).map(machineOf)),
  ];
  // Connecting can't help a machine this connection may not change.
  const denied = machinesThatAre("denied");
  if (denied.length > 0) return `This connection can't change projects on ${listOf(denied)}.`;
  const offline = machinesThatAre("offline");
  if (offline.length > 0) return `Connect ${listOf(offline)} to ${goal}.`;
  const loading = machinesThatAre("loading");
  if (loading.length === 0) return null;
  return `${sentenceStart(listOf(loading))} ${loading.length === 1 ? "is" : "are"} still loading…`;
}

function listOf(names: ReadonlyArray<string>) {
  return names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/** What a removal that stopped partway says: what may already be gone, then what to do. */
export function describeProjectRemovalFailure(input: {
  readonly kind: "denied" | "loading" | "unsent" | "interrupted" | "rejected";
  readonly target: string;
  readonly machine: string;
  /** Checkouts this attempt removed before it stopped. */
  readonly removedCount: number;
  readonly error?: unknown;
  /** False in a view that hides the project list, such as a confirmation dialog. */
  readonly listInView: boolean;
}): ProjectRemovalFailure {
  const removed =
    input.removedCount === 0
      ? null
      : `${input.removedCount} other checkout${input.removedCount === 1 ? " was" : "s were"} already removed`;
  // The server deletes a project's threads before the project, so stopping can leave some deleted.
  const threadsGone = removed
    ? `${removed}, and some of this one's threads may be deleted`
    : "Some of its threads may already be deleted";
  if (input.kind === "denied") {
    return {
      title: `Failed to remove ${input.target}`,
      cause: `This connection can't change projects on ${input.machine}`,
      loss: removed,
      advice: null,
    };
  }
  // Nothing was sent for this checkout, so none of its threads can be gone.
  if (input.kind === "loading") {
    return {
      title: `Failed to remove ${input.target}`,
      cause: `${sentenceStart(input.machine)} is still loading`,
      loss: removed,
      advice: "Try again in a moment",
    };
  }
  if (input.kind === "unsent") {
    return {
      title: `Failed to remove ${input.target}`,
      cause: `${sentenceStart(input.machine)} isn't connected`,
      loss: removed,
      advice: `Connect ${input.machine} and try again`,
    };
  }
  return {
    title:
      input.kind === "interrupted"
        ? `Couldn't confirm ${input.target} was removed`
        : `Failed to remove ${input.target}`,
    cause:
      input.kind === "interrupted"
        ? "The connection dropped"
        : // The server's generic mutation message only repeats the title.
          input.error instanceof Error && !isProjectMutationError(input.error)
          ? input.error.message
          : null,
    loss: threadsGone,
    advice:
      input.kind === "interrupted" && input.listInView
        ? "If the project is still listed, try again"
        : "Try again to finish",
  };
}

/**
 * What removing now would delete or stop beyond what the confirmation said, in the palette
 * dialog's words, or null when nothing grew. The confirmation shows a count and the threads it
 * stops, so more threads, or one that started running, need their own answer.
 */
export function projectRemovalGrowth<
  Thread extends Pick<EnvironmentThreadShell, "environmentId" | "id" | "title">,
>(confirmed: ProjectRemovalThreads<Thread>, now: ProjectRemovalThreads<Thread>): string | null {
  const keyOf = (thread: Thread) => `${thread.environmentId}:${thread.id}`;
  const held = new Set(confirmed.projectThreads.map(keyOf));
  const stopping = new Set(confirmed.runningThreads.map(keyOf));
  const newlyRunning = now.runningThreads.filter((thread) => !stopping.has(keyOf(thread)));
  // A thread that arrived running is named once, as one that stops.
  const moreDeleted =
    now.threadCount -
    confirmed.threadCount -
    newlyRunning.filter((thread) => !held.has(keyOf(thread))).length;
  if (moreDeleted <= 0 && newlyRunning.length === 0) return null;
  return [
    ...(moreDeleted > 0
      ? [`Now deletes ${moreDeleted} more thread${moreDeleted === 1 ? "" : "s"}.`]
      : []),
    ...(newlyRunning.length === 1
      ? [`Now stops "${newlyRunning[0]!.title}".`]
      : newlyRunning.length > 1
        ? [`Now stops ${newlyRunning.length} more unfinished threads.`]
        : []),
  ].join(" ");
}

interface ProjectRemovalThreads<Thread> {
  readonly projectThreads: ReadonlyArray<Thread>;
  readonly runningThreads: ReadonlyArray<Thread>;
  readonly threadCount: number;
}

/** The question asked again, opening with what changed, so a dialog that titles it shows that. */
export function projectRemovalReconfirmation(
  plan: { readonly confirmationMessage: string },
  growth: string,
) {
  const [question = "", ...rest] = plan.confirmationMessage.split("\n");
  return [`${growth} ${question}`, ...rest].join("\n");
}

export function planProjectRemoval<
  Thread extends Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "lineage"> &
    Partial<Pick<EnvironmentThreadShell, "runtime">>,
>(options: {
  readonly members: ReadonlyArray<
    Pick<EnvironmentProject, "id" | "environmentId" | "title" | "workspaceRoot"> & {
      readonly environmentLabel?: string | null;
    }
  >;
  readonly groupMemberCount: number;
  readonly hasOtherMembers: boolean;
  readonly displayName: string;
  readonly threads: ReadonlyArray<Thread>;
  /** The members' threads this client does not hold: older settled threads its shell left out. */
  readonly unloadedThreadCount?: number;
}) {
  const { members, groupMemberCount, hasOtherMembers, displayName, threads } = options;
  const memberKeys = new Set(members.map((member) => `${member.environmentId}:${member.id}`));
  const projectThreads = threads.filter((thread) =>
    memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
  );
  // Side chats and subagents go with their parent but never show in thread lists.
  const listedThreads = projectThreads.filter((thread) => isListedThreadLineage(thread.lineage));
  const threadCount = listedThreads.length + (options.unloadedThreadCount ?? 0);
  // Removal stops these; archiving refuses them.
  const runningThreads = listedThreads.filter((thread) => !threadRuntimeCanArchive(thread.runtime));
  const runningThreadCount = runningThreads.length;
  const isWholeGroup = members.length === groupMemberCount;
  const targetKind = hasOtherMembers || !isWholeGroup ? "checkout" : "project";
  const singleMember = members.length === 1 ? members[0]! : null;
  const targetLabel = singleMember?.title ?? displayName;
  // A scope can hold several checkouts of the project, which the question counts.
  const target =
    targetKind === "checkout" && members.length > 1
      ? `${members.length} checkouts of "${displayName}"`
      : `${targetKind} "${targetLabel}"`;
  const confirmationMessage = [
    threadCount > 0
      ? `Remove ${target} and delete ${targetKind === "checkout" && members.length > 1 ? "their" : "its"} ${threadCount} thread${threadCount === 1 ? "" : "s"}?`
      : `Remove ${target}?`,
    ...(singleMember
      ? [
          `Path: ${singleMember.workspaceRoot}`,
          ...(singleMember.environmentLabel
            ? [`Environment: ${singleMember.environmentLabel}`]
            : []),
        ]
      : // A scope of some checkouts already counts them in the question.
        targetKind === "checkout"
        ? []
        : [
            members.length === 2
              ? "This removes both checkouts."
              : `This removes all ${members.length} checkouts.`,
          ]),
    ...(threadCount > 0
      ? [
          "Those threads and any archived threads are deleted from T3 Code. Provider sessions are kept.",
        ]
      : ["Any archived threads are deleted from T3 Code. Provider sessions are kept."]),
    ...(runningThreadCount > 0
      ? [`Stops ${runningThreadCount} unfinished thread${runningThreadCount === 1 ? "" : "s"}.`]
      : []),
    ...(isWholeGroup && !hasOtherMembers ? [] : ["The project's other checkouts stay."]),
    `${members.length === 1 ? "The project folder stays" : "Project folders stay"} on disk. Thread worktrees follow your storage cleanup settings.`,
    "This can't be undone.",
  ].join("\n");

  return {
    projectThreads,
    threadCount,
    runningThreads,
    runningThreadCount,
    isWholeGroup,
    targetKind,
    confirmationMessage,
  };
}
