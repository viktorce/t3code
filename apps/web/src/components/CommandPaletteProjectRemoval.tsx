import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  planProjectRemoval,
  projectRemovalReadiness,
} from "@t3tools/client-runtime/state/projects";
import {
  AuthOrchestrationOperateScope,
  isListedThreadLineage,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { useEffect, useState } from "react";

import { type ProjectRemovalOutcome, useProjectGroupRemoval } from "../hooks/useProjectGroupUpdate";
import {
  ariaKeyShortcutsForCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../keybindings";
import type { SidebarProjectGroupMember, SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { useProjects, useServerConfigs, useThreadShellsForProjectRefs } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { readUnloadedThreadCount } from "../state/olderSettledShelf";
import { useEnvironmentScopeStates } from "../state/session";
import { liveShellEnvironmentIdsAtom } from "../state/shell";
import type { CommandPaletteProjectLocation } from "./CommandPaletteProjectItems";
import { RemoveProjectDialog } from "./RemoveProjectDialog";
import {
  buildRemoveProjectRequest,
  eitherCleanupRule,
  findRemoveProjectBlocker,
  type RemoveProjectCheckout,
  type RemoveProjectFailure,
  type RemoveProjectRequest,
} from "./RemoveProjectDialog.logic";
import { toastManager } from "./ui/toast";

/**
 * Confirms and runs the removal of the project a palette row stands for, every checkout of it.
 * The summary follows the threads live until Remove is pressed, then freezes, so it does not count
 * down while the server deletes them. A failure keeps the dialog open on what is left, so trying
 * again is one press. Kept out of the palette so thread updates re-render only this.
 */
export function CommandPaletteProjectRemoval(props: {
  readonly group: SidebarProjectSnapshot | null;
  readonly locations: ReadonlyMap<EnvironmentId, CommandPaletteProjectLocation>;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly onClose: () => void;
  /** Closes what covers the settings page that the dialog's link opens. */
  readonly onFollowSettingsLink: () => void;
}) {
  const { group, locations, keybindings, onClose } = props;
  const members = group?.memberProjects ?? [];
  const threads = useThreadShellsForProjectRefs(
    members.map((member) => scopeProjectRef(member.environmentId, member.id)),
  );
  const projects = useProjects();
  const liveEnvironmentIds = useAtomValue(liveShellEnvironmentIdsAtom);
  const { environments } = useEnvironments();
  const serverConfigs = useServerConfigs();
  // Asked of the members' own machines, which still answer once their last project is gone.
  // A machine that hasn't connected since the app started has no session to grant or refuse yet.
  const scopeStates = useEnvironmentScopeStates(members, AuthOrchestrationOperateScope);
  const { removeProjectMembers } = useProjectGroupRemoval();
  // Set while removing: the live group shrinks as checkouts go, and the summary must not.
  const [frozen, setFrozen] = useState<RemoveProjectRequest | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<RemoveProjectFailure | null>(null);
  // Closing drops the last try's error, so the next dialog starts clean.
  if (group === null && failure !== null) setFailure(null);

  const locationOf = (member: SidebarProjectGroupMember) =>
    locations.get(member.environmentId)?.label ?? member.environmentLabel ?? "Remote";
  const machineOf = (member: SidebarProjectGroupMember) =>
    locations.get(member.environmentId)?.kind === "local" ? "this machine" : locationOf(member);
  // A machine that reconnects still has to load its threads and projects before they are whole.
  const stateOf = (member: SidebarProjectGroupMember) => {
    const environment = environments.find((entry) => entry.environmentId === member.environmentId);
    if (environment?.connection.phase !== "connected") return "offline";
    return environment.serverConfig && liveEnvironmentIds.has(member.environmentId)
      ? "live"
      : "loading";
  };

  const plan = group
    ? planProjectRemoval({
        members,
        groupMemberCount: members.length,
        hasOtherMembers: false,
        displayName: group.displayName,
        threads,
        unloadedThreadCount: readUnloadedThreadCount(members, threads),
      })
    : null;
  const checkouts = members.map((member): RemoveProjectCheckout => {
    const serverConfig = serverConfigs.get(member.environmentId);
    return {
      key: `${member.environmentId}:${member.id}`,
      location: locationOf(member),
      machine: machineOf(member),
      workspaceRoot: member.workspaceRoot,
      // A server that keeps a removed project's own cleanup rule applies it to the worktrees its
      // threads leave. An older one drops it with the project, and its sweeps can run before or
      // after that, so either rule may apply; the one that deletes more is the honest summary.
      cleanup: serverConfig
        ? serverConfig.environment.capabilities.removedProjectCleanupRule === true
          ? resolveWorktreeCleanup(serverConfig.settings, member.id)
          : eitherCleanupRule(
              resolveWorktreeCleanup(serverConfig.settings, member.id),
              resolveWorktreeCleanup(serverConfig.settings, null),
            )
        : null,
      hasWorktrees: threads.some(
        (thread) =>
          thread.environmentId === member.environmentId &&
          thread.projectId === member.id &&
          thread.worktreePath !== null,
      ),
      connection: projectRemovalReadiness(
        environments.find((entry) => entry.environmentId === member.environmentId),
        scopeStates.get(member.environmentId) ?? "unknown",
        liveEnvironmentIds.has(member.environmentId),
      ),
      // Older threads the list loads were counted all along, as ones it doesn't hold.
      threadCount:
        threads.filter(
          (thread) =>
            thread.environmentId === member.environmentId &&
            thread.projectId === member.id &&
            isListedThreadLineage(thread.lineage),
        ).length + readUnloadedThreadCount([member], threads),
    };
  });
  const liveRequest =
    group && plan
      ? buildRemoveProjectRequest({
          name: group.displayName,
          threadCount: plan.threadCount,
          // The threads it counts; side chats and subagents go with their parent uncounted.
          threadKeys: plan.projectThreads
            .filter((thread) => isListedThreadLineage(thread.lineage))
            .map((thread) => `${thread.environmentId}:${thread.id}`),
          runningThreads: plan.runningThreads.map((thread) => ({
            key: `${thread.environmentId}:${thread.id}`,
            title: thread.title,
          })),
          checkouts,
        })
      : null;
  const blocker = findRemoveProjectBlocker(checkouts);
  // The project can go while the dialog is open: another device removed it, or a removal whose
  // reply a dropped connection lost went through after all.
  const goneName =
    group !== null &&
    !pending &&
    members.every((member) => stateOf(member) === "live") &&
    !members.some((member) =>
      projects.some(
        (project) => project.environmentId === member.environmentId && project.id === member.id,
      ),
    )
      ? group.displayName
      : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server's removal closes the dialog once
  useEffect(() => {
    if (goneName === null) return;
    onClose();
    toastManager.add({ type: "success", title: `"${goneName}" was removed` });
  }, [goneName, onClose]);

  const confirm = async () => {
    if (group === null || plan === null || liveRequest === null || blocker !== null || pending) {
      return;
    }
    // A new alert for each try is read out even when its message repeats.
    const attempt = (failure?.attempt ?? 0) + 1;
    setFrozen(liveRequest);
    setPending(true);
    let outcome: ProjectRemovalOutcome = "failed";
    try {
      outcome = await removeProjectMembers(members, plan.projectThreads, {
        labelFor: machineOf,
        onFailure: (next) => setFailure({ ...next, attempt }),
      });
    } catch (error) {
      setFailure({
        attempt,
        title: "Failed to remove the project",
        cause: error instanceof Error ? error.message : "An error occurred",
        loss: null,
        advice: null,
      });
    }
    // The summary goes live again, so after a failure it shows only what is left.
    setPending(false);
    setFrozen(null);
    if (outcome === "failed") return;
    onClose();
    toastManager.add({
      type: "success",
      title: `Removed "${group.displayName}"`,
      ...(outcome === "unconfirmed"
        ? { description: "It can take a moment to leave this list." }
        : {}),
    });
  };

  return (
    <RemoveProjectDialog
      request={frozen ?? liveRequest}
      blockedBy={frozen ? null : blocker}
      pending={pending}
      failure={failure}
      confirmShortcutLabel={shortcutLabelForCommand(keybindings, "project.remove")}
      confirmAriaKeyShortcuts={ariaKeyShortcutsForCommand(keybindings, "project.remove")}
      isConfirmShortcut={(event) =>
        resolveShortcutCommand(event, keybindings, {
          platform: navigator.platform,
          context: { modelPickerOpen: false },
        }) === "project.remove"
      }
      settingsLink={
        group ? { projectKey: group.projectKey, onFollow: props.onFollowSettingsLink } : null
      }
      onCancel={onClose}
      onConfirm={() => void confirm()}
    />
  );
}
