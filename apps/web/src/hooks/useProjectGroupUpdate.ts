import { AuthOrchestrationOperateScope, type ProjectIconOverride } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  describeProjectRemovalFailure,
  isProjectNotFoundError,
  isProjectRemovalUnsent,
  projectRemovalFailureText,
  projectRemovalReadiness,
  projectRemovalRefusal,
  projectRemovalTarget,
  type ProjectRemovalFailure,
} from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import { releaseProjectDraftUploads } from "../lib/composerDraftUploads";
import type { SidebarProjectGroupMember } from "../sidebarProjectGrouping";
import {
  readProject,
  useProjects,
  useServerConfigs,
  waitForProjectRemoval,
} from "../state/entities";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readEnvironment } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import {
  readEnvironmentScopeState,
  useEnvironmentScopeStates,
  useEnvironmentsWithScope,
} from "../state/session";
import { liveShellEnvironmentIdsAtom } from "../state/shell";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

export type ProjectGroupUpdate = Partial<{
  title: string;
  faviconPath: string | null;
  projectIcon: ProjectIconOverride | null;
  pinned: boolean;
  archived: boolean;
}>;

type ProjectGroupMember = Pick<
  SidebarProjectGroupMember,
  "environmentId" | "id" | "environmentLabel"
>;

/**
 * Writes one update to each checkout of a project, one machine at a time, and
 * reports the first failure as a toast. Every machine must be connected first.
 */
export function useProjectGroupUpdate() {
  const serverConfigs = useServerConfigs();
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });

  const updateProjectGroup = async <TMember extends ProjectGroupMember>(
    members: ReadonlyArray<TMember>,
    input: ProjectGroupUpdate | ((member: TMember) => ProjectGroupUpdate),
    failureTitle: string,
  ): Promise<AtomCommandResult<void, unknown>> => {
    const refused = refuseUnready(members, failureTitle, false);
    if (refused) return refused;
    for (const member of members) {
      // A machine can drop, lose its grant, or fail a session check between writes.
      const changed = refuseUnready([member], failureTitle, false);
      if (changed) return changed;
      const result = mapAtomCommandResult(
        await updateProject({
          environmentId: member.environmentId,
          input: {
            projectId: member.id,
            ...(typeof input === "function" ? input(member) : input),
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        reportProjectFailure(
          members.length > 1
            ? `${failureTitle} on ${member.environmentLabel ?? "the current environment"}`
            : failureTitle,
          result,
        );
        return result;
      }
    }
    return AsyncResult.success(undefined);
  };

  /** Older servers drop pin and archive, so their projects do not offer them. */
  const canOrganizeProjectGroup = (members: ReadonlyArray<ProjectGroupMember>) =>
    members.every(
      (member) =>
        serverConfigs.get(member.environmentId)?.environment.capabilities.projectOrganization ===
        true,
    );

  return { updateProjectGroup, canOrganizeProjectGroup };
}

/** Pin state for a project group, shared by every list that can pin or unpin a project. */
export function useProjectPin() {
  const { updateProjectGroup, canOrganizeProjectGroup } = useProjectGroupUpdate();
  const environments = [...new Set(useProjects().map((project) => project.environmentId))].map(
    (environmentId) => ({ environmentId }),
  );
  const operableEnvironmentIds = useEnvironmentsWithScope(
    environments,
    AuthOrchestrationOperateScope,
  );
  type PinnableGroup = {
    readonly memberProjects: ReadonlyArray<ProjectGroupMember>;
    readonly pinned: boolean;
  };
  const canPinProjectGroup = (group: PinnableGroup) =>
    canOrganizeProjectGroup(group.memberProjects) &&
    group.memberProjects.every((member) => operableEnvironmentIds.has(member.environmentId));
  const setProjectGroupPinned = (group: PinnableGroup, pinned: boolean) => {
    void updateProjectGroup(
      group.memberProjects,
      { pinned },
      pinned ? "Failed to pin project" : "Failed to unpin project",
    );
  };
  return {
    canPinProjectGroup,
    setProjectGroupPinned,
    toggleProjectGroupPin: (group: PinnableGroup) => setProjectGroupPinned(group, !group.pinned),
  };
}

export type ProjectRemovalOutcome = "removed" | "unconfirmed" | "failed";

/** Project removal, shared by Settings and the command palette. */
export function useProjectGroupRemoval() {
  const deleteProject = useOrchestrationCommand(projectEnvironment.delete, {
    reportFailure: false,
  });
  const environments = [...new Set(useProjects().map((project) => project.environmentId))].map(
    (environmentId) => ({ environmentId }),
  );
  // Only a session that refuses hides removal. One that hasn't loaded, as for a machine offline
  // since the app started, may well allow it, and the dialog says what removal waits for.
  const scopeStates = useEnvironmentScopeStates(environments, AuthOrchestrationOperateScope);
  const canRemoveProjectGroup = (members: ReadonlyArray<ProjectGroupMember>) =>
    members.every((member) => scopeStates.get(member.environmentId) !== "denied");

  /**
   * Deletes each entry with its threads, then drops this client's drafts for them.
   * "unconfirmed" means the server removed it but this client's list has not caught up yet.
   */
  const removeProjectMembers = async <
    TMember extends ProjectGroupMember & { readonly title: string; readonly workspaceRoot: string },
  >(
    members: ReadonlyArray<TMember>,
    projectThreads: ReadonlyArray<
      Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "id">
    >,
    options: {
      /** Names a member's machine the way the caller's UI does. */
      readonly labelFor?: (member: TMember) => string;
      /**
       * Shows a failure beside the project in place of the default toast. That view already names
       * a lone project, and it hides the project list.
       */
      readonly onFailure?: (failure: ProjectRemovalFailure) => void;
    } = {},
  ): Promise<ProjectRemovalOutcome> => {
    const labelOf = (member: TMember) =>
      options.labelFor?.(member) ?? member.environmentLabel ?? "the current environment";
    const report = (failure: ProjectRemovalFailure) => {
      if (options.onFailure) options.onFailure(failure);
      else {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: failure.title,
            description: projectRemovalFailureText(failure),
          }),
        );
      }
    };
    const failedTitle = options.onFailure
      ? "Failed to remove the project"
      : "Failed to remove project";
    // Read as of now, not when the confirmation opened: while it waits, a machine can drop, lose
    // its grant, or start reloading the threads it counted. Deleting then would leave the rest of
    // the project behind, or delete threads nobody confirmed.
    const unready = findUnready(members, true);
    if (unready) {
      report(projectRemovalRefusal(failedTitle, unready.readiness, labelOf(unready.member)));
      return "failed";
    }
    const draftStore = useComposerDraftStore.getState();
    let removedCount = 0;
    const cleanups: Array<Promise<boolean>> = [];
    // Every exit after the first deletion says what is already gone.
    const fail = (
      member: TMember,
      kind: "denied" | "loading" | "unsent" | "interrupted" | "rejected",
      error?: unknown,
    ): ProjectRemovalOutcome => {
      report(
        describeProjectRemovalFailure({
          kind,
          target: projectRemovalTarget(member, members, labelOf, {
            projectNamed: options.onFailure !== undefined,
          }),
          machine: labelOf(member),
          removedCount,
          error,
          listInView: options.onFailure === undefined,
        }),
      );
      return "failed";
    };
    for (const member of members) {
      // Read again for each checkout: while earlier ones go, a machine can drop, lose its grant, or
      // fail a session check. Threads don't matter here; the confirmation already counted them.
      const readiness = projectRemovalReadiness(
        readEnvironment(member.environmentId),
        readEnvironmentScopeState(member.environmentId, AuthOrchestrationOperateScope),
        true,
      );
      if (readiness !== "ready") {
        return fail(member, readiness === "offline" ? "unsent" : readiness);
      }
      const result = mapAtomCommandResult(
        await deleteProject({
          environmentId: member.environmentId,
          input: { projectId: member.id, force: true },
        }),
        () => undefined,
      );
      const projectRef = scopeProjectRef(member.environmentId, member.id);
      // Another client, or an earlier attempt, may have removed it already; that is the goal.
      // Older servers do not say "not found", and this client's list can lag behind the server.
      const alreadyGone =
        result._tag === "Failure" &&
        !isAtomCommandInterrupted(result) &&
        (isProjectNotFoundError(squashAtomCommandFailure(result)) ||
          readProject(projectRef) === null);
      if (result._tag === "Failure" && !alreadyGone) {
        // A dropped connection interrupts the command, and the server may or may not have applied
        // it. Trying again is safe either way, since a project that is already gone counts as removed.
        if (isAtomCommandInterrupted(result)) return fail(member, "interrupted");
        const error = squashAtomCommandFailure(result);
        // A machine that dropped after an earlier checkout went never received this one.
        return isProjectRemovalUnsent(error)
          ? fail(member, "unsent")
          : fail(member, "rejected", error);
      }
      removedCount += 1;
      // Each list catches up on its own; waiting in turn would hold the caller for every checkout.
      cleanups.push(
        (alreadyGone ? Promise.resolve(true) : waitForProjectRemoval(projectRef)).then(
          (caughtUp) => {
            releaseProjectDraftUploads(
              projectRef,
              projectThreads
                .filter(
                  (thread) =>
                    thread.environmentId === member.environmentId && thread.projectId === member.id,
                )
                .map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
            );
            const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
            if (projectDraftThread) draftStore.clearDraftThread(projectDraftThread.draftId);
            draftStore.clearProjectDraftThreadId(projectRef);
            return caughtUp;
          },
        ),
      );
    }
    return (await Promise.all(cleanups)).every(Boolean) ? "removed" : "unconfirmed";
  };

  return { canRemoveProjectGroup, removeProjectMembers };
}

/** The first member whose machine can't take a change, read as of this moment. */
function findUnready<TMember extends Pick<ProjectGroupMember, "environmentId">>(
  members: ReadonlyArray<TMember>,
  // A removal deletes the threads its confirmation counted, so it waits for them to load too.
  countsThreads: boolean,
) {
  const live = appAtomRegistry.get(liveShellEnvironmentIdsAtom);
  for (const member of members) {
    const readiness = projectRemovalReadiness(
      readEnvironment(member.environmentId),
      readEnvironmentScopeState(member.environmentId, AuthOrchestrationOperateScope),
      !countsThreads || live.has(member.environmentId),
    );
    if (readiness !== "ready") return { member, readiness };
  }
  return null;
}

/** Reports the first member whose machine can't take a change yet, and returns that failure. */
function refuseUnready(
  members: ReadonlyArray<ProjectGroupMember>,
  failureTitle: string,
  countsThreads: boolean,
): AtomCommandResult<void, unknown> | null {
  const unready = findUnready(members, countsThreads);
  if (!unready) return null;
  const refusal = projectRemovalRefusal(
    failureTitle,
    unready.readiness,
    unready.member.environmentLabel ?? "the selected environment",
  );
  return failWith(refusal.title, projectRemovalFailureText(refusal));
}

/** Reports the first member whose machine can't take its removal yet, and returns that failure. */
export function checkProjectRemoval(
  members: ReadonlyArray<ProjectGroupMember>,
  failureTitle: string,
): AtomCommandResult<void, unknown> | null {
  return refuseUnready(members, failureTitle, true);
}

export function reportProjectFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

function failWith(title: string, message: string): AtomCommandResult<void, unknown> {
  const result = AsyncResult.failure<void, Error>(Cause.fail(new Error(message)));
  reportProjectFailure(title, result);
  return result;
}
