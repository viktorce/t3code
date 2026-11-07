import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import { planProjectRemoval } from "@t3tools/client-runtime/state/projects";
import {
  mapAtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  resolveEnvironmentMachineKind,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { CircleAlertIcon, UnplugIcon } from "lucide-react";
import { Fragment, useRef, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { checkProjectAccess } from "../../hooks/useProjectGroupUpdate";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useProjects, useThreadShells, waitForProjectRemoval } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { readUnloadedThreadCount } from "../../state/olderSettledShelf";
import { projectEnvironment } from "../../state/projects";
import { readEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { Alert, AlertDescription } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { settingsScopeTrigger } from "./SettingsScopeSentence";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

export interface ProjectRemovalRequest {
  readonly group: SidebarProjectSnapshot;
  readonly members: ReadonlyArray<SidebarProjectGroupMember>;
  /** The group has members outside the picked machine or checkout, and they stay. */
  readonly hasOtherMembers: boolean;
  /** Awaited before the dialog closes, so focus lands in the view it leads to. */
  readonly onRemoved?: () => Promise<void>;
  /** Takes focus once the dialog closes and its opener is gone, usually with its project. */
  readonly focusAfterRemoval?: () => HTMLElement | null;
}

const FAILURE_TITLE = "Failed to remove project";
/** The project page's Checkouts section, a settings search target. */
export const PROJECT_CHECKOUTS_TARGET_ID = "project-checkouts";
const NO_ACCESS = "This connection can no longer change projects there.";

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Labels the destructive action, here and on the buttons that open this dialog. */
export function projectRemovalLabel(
  members: ReadonlyArray<Pick<SidebarProjectGroupMember, "environmentId">>,
  isCheckout: boolean,
) {
  if (isCheckout) {
    return members.length === 1 ? "Remove checkout" : `Remove ${members.length} checkouts`;
  }
  return new Set(members.map((member) => member.environmentId)).size > 1
    ? "Remove everywhere"
    : "Remove project";
}

/** Render `removalDialog` above anything the removal unmounts, such as the project's own page. */
export function useProjectRemoval() {
  const [request, setRequest] = useState<ProjectRemovalRequest | null>(null);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const requestRemoval = (next: ProjectRemovalRequest) => {
    if (checkProjectAccess(next.members, FAILURE_TITLE)) return;
    const active = document.activeElement;
    setOpener(active instanceof HTMLElement && active !== document.body ? active : null);
    setRequest(next);
    setOpen(true);
  };
  const removalDialog = request ? (
    <ProjectRemovalDialog
      request={request}
      opener={opener}
      open={open}
      onClose={() => setOpen(false)}
      onClosed={() => setRequest(null)}
    />
  ) : null;
  return { requestRemoval, removalDialog, removalOpen: request !== null };
}

// Mounted only while a removal is pending, so idle lists do not follow every thread change.
function ProjectRemovalDialog({
  request,
  opener,
  open,
  onClose,
  onClosed,
}: {
  request: ProjectRemovalRequest;
  opener: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  onClosed: () => void;
}) {
  const { group, members, hasOtherMembers, onRemoved, focusAfterRemoval } = request;
  const projects = useProjects();
  const groups = useSettingsProjectGroups();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const deleteProject = useOrchestrationCommand(projectEnvironment.delete, {
    reportFailure: false,
  });
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Registrations the server confirmed deleted, which the store can still list until it syncs.
  const [deletedKeys, setDeletedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [removedKeys, setRemovedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [failure, setFailure] = useState<{
    readonly member: SidebarProjectGroupMember;
    readonly reason: string;
  } | null>(null);
  // Checkouts that had a delete sent. The server deletes a project's threads before the
  // project, so a checkout can lose threads without being removed, and nothing is left to cancel.
  const [touchedKeys, setTouchedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [listOverflows, setListOverflows] = useState(false);
  const remaining = members.filter((member) => !removedKeys.has(member.physicalProjectKey));
  const remainingKeys = new Set(remaining.map((member) => member.physicalProjectKey));
  // A checkout row also stands for stale duplicate registrations at its path.
  const registrations = projects.filter(
    (project) =>
      remainingKeys.has(derivePhysicalProjectKey(project)) &&
      !deletedKeys.has(scopedProjectKey(scopeProjectRef(project.environmentId, project.id))),
  );
  const livePlan = planProjectRemoval({
    members,
    registrations,
    groupMemberCount: group.memberProjects.length,
    hasOtherMembers,
    displayName: group.displayName,
    threads,
    unloadedThreadCount: readUnloadedThreadCount(registrations, threads),
  });
  // Deleting threads moves the live counts, so the copy holds still while an attempt runs.
  const [attemptPlan, setAttemptPlan] = useState<typeof livePlan | null>(null);
  const removing = attemptPlan !== null;
  const plan = attemptPlan ?? livePlan;
  const isCheckout = plan.targetKind === "checkout";

  const environmentOf = (member: SidebarProjectGroupMember) =>
    environments.find((environment) => environment.environmentId === member.environmentId);
  const machineName = (member: SidebarProjectGroupMember) => {
    const environment = environmentOf(member);
    return environment
      ? settingsScopeEnvironmentLabel(environment, environments)
      : (member.environmentLabel ?? member.environmentId);
  };
  const offlineMachines = [
    ...new Set(
      remaining
        .filter((member) => environmentOf(member)?.connection.phase !== "connected")
        .map(machineName),
    ),
  ];
  const showMachines = environments.length > 1;
  const machineRows = showMachines && members.length > 1;
  // Only a list that scrolls needs a tab stop, so keyboard users can scroll it.
  const observeListOverflow = (list: HTMLUListElement | null) =>
    list
      ? observeResize(list, () => setListOverflows(list.scrollHeight > list.clientHeight))
      : undefined;

  const remove = async () => {
    const canOperate = (member: SidebarProjectGroupMember) =>
      readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope);
    const denied = remaining.find((member) => !canOperate(member));
    if (denied) return setFailure({ member: denied, reason: NO_ACCESS });
    setFailure(null);
    setAttemptPlan(livePlan);
    const deleted: ScopedProjectRef[] = [];
    // The server already confirmed these deletes, so a sync timeout still counts as removed.
    const settle = async () => {
      await Promise.all(deleted.map((projectRef) => waitForProjectRemoval(projectRef)));
      const draftStore = useComposerDraftStore.getState();
      for (const projectRef of deleted) {
        releaseProjectDraftUploads(
          projectRef,
          livePlan.projectThreads
            .filter(
              (thread) =>
                thread.environmentId === projectRef.environmentId &&
                thread.projectId === projectRef.projectId,
            )
            .map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
        );
        const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
        if (projectDraftThread) draftStore.clearDraftThread(projectDraftThread.draftId);
        draftStore.clearProjectDraftThreadId(projectRef);
      }
    };
    const fail = async (member: SidebarProjectGroupMember, reason: string) => {
      await settle();
      setFailure({ member, reason });
      setAttemptPlan(null);
    };
    for (const member of remaining) {
      for (const project of registrations.filter(
        (registration) => derivePhysicalProjectKey(registration) === member.physicalProjectKey,
      )) {
        if (!canOperate(member)) return fail(member, NO_ACCESS);
        setTouchedKeys((current) => new Set(current).add(member.physicalProjectKey));
        const result = mapAtomCommandResult(
          await deleteProject({
            environmentId: project.environmentId,
            input: { projectId: project.id, force: true },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          return fail(member, error instanceof Error ? error.message : "An error occurred.");
        }
        const projectRef = scopeProjectRef(project.environmentId, project.id);
        deleted.push(projectRef);
        setDeletedKeys((current) => new Set(current).add(scopedProjectKey(projectRef)));
      }
      setRemovedKeys((current) => new Set(current).add(member.physicalProjectKey));
    }
    await settle();
    const machines = [...new Set(members.map(machineName))];
    const where = machines.length === 1 ? machines[0] : `${machines.length} machines`;
    toastManager.add({
      type: "success",
      title: !isCheckout
        ? `Removed "${group.displayName}"`
        : members.length === 1
          ? `Removed "${members[0]!.title}" on ${where}`
          : `Removed ${members.length} checkouts on ${where}`,
    });
    await onRemoved?.();
    // `removing` stays on, so the closing dialog's button cannot start this again.
    onClose();
  };

  const machineCount = new Set(members.map((member) => member.environmentId)).size;
  const summary: ReadonlyArray<readonly [term: string, detail: string]> = [
    ...(!isCheckout && members.length > 1
      ? [
          [
            "Removes",
            `${members.length === 2 ? "Both checkouts" : `All ${members.length} checkouts`}${
              machineCount > 1 ? ` on ${machineCount} machines` : ""
            }`,
          ] as const,
        ]
      : []),
    [
      "Deletes",
      plan.threadCount > 0
        ? `${plural(plan.threadCount, "thread")} and any archived ones`
        : "Any archived threads",
    ],
    ...(plan.runningThreadCount > 0
      ? [["Stops", plural(plan.runningThreadCount, "running agent")] as const]
      : []),
    [
      "Keeps",
      isCheckout
        ? `Other checkouts of "${group.displayName}", files on disk and provider session history`
        : "Files on disk and provider session history",
    ],
  ];
  const targetName = (member: SidebarProjectGroupMember) =>
    `"${members.length > 1 || isCheckout ? member.title : group.displayName}" on ${machineName(member)}`;
  // Touched but not removed: some of their threads can already be gone, whatever failed last.
  const incomplete = remaining.filter((member) => touchedKeys.has(member.physicalProjectKey));
  const failureMessage = failure
    ? `${members.length > 1 ? `Removed ${removedKeys.size} of ${members.length} checkouts. ` : ""}Couldn't remove ${targetName(failure.member)}: ${failure.reason}`
    : null;
  const failureNote =
    failure && incomplete.length > 0
      ? `Some threads of ${new Intl.ListFormat("en").format(incomplete.map(targetName))} may already be deleted. Retry finishes the removal.`
      : null;
  const confirmLabel = projectRemovalLabel(members, isCheckout);
  const survivingRow = () => {
    const survivor = groups.find((candidate) =>
      candidate.memberProjects.some((member) => remainingKeys.has(member.physicalProjectKey)),
    );
    return survivor
      ? document.querySelector<HTMLElement>(
          `[data-project-key="${CSS.escape(survivor.projectKey)}"]`,
        )
      : null;
  };
  // Base UI restores focus without scrolling, and a replacement target can sit out of view.
  const reveal = (target: HTMLElement | null | undefined) => {
    target?.scrollIntoView({ block: "nearest" });
    return target ?? true;
  };
  // With checkouts left, a regroup can take the opener away and a revoked grant can disable it.
  // Focus then goes to the list row now holding those checkouts, or on a project page to a
  // surviving checkout or the first control in the Checkouts list.
  const focusWithCheckoutsLeft = () =>
    opener?.isConnected && !opener.matches(":disabled")
      ? opener
      : reveal(
          survivingRow() ??
            focusAfterRemoval?.() ??
            document
              .getElementById(PROJECT_CHECKOUTS_TARGET_ID)
              ?.querySelector<HTMLElement>("button:enabled"),
        );

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !removing) onClose();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClosed();
      }}
    >
      <AlertDialogPopup
        // Otherwise the target list, a tab stop while it scrolls, would take initial focus.
        initialFocus={cancelRef}
        finalFocus={() =>
          remaining.length === 0
            ? reveal(focusAfterRemoval?.() ?? settingsScopeTrigger("project"))
            : focusWithCheckoutsLeft()
        }
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {!isCheckout
              ? `Remove "${group.displayName}"?`
              : members.length === 1
                ? "Remove this checkout?"
                : `Remove ${members.length} checkouts?`}
          </AlertDialogTitle>
          <AlertDialogDescription render={<div />}>
            <div className="flex flex-col gap-2 text-left">
              {members.every((member) => member.isScratch) ? (
                <p>
                  It holds threads started without a project. It comes back the next time you start
                  a thread without one.
                </p>
              ) : null}
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                {summary.map(([term, detail]) => (
                  <Fragment key={term}>
                    <dt className="font-medium text-foreground">{term}</dt>
                    <dd>{detail}</dd>
                  </Fragment>
                ))}
              </dl>
              <p>You can't undo this.</p>
            </div>
          </AlertDialogDescription>
          <div className="mt-2 flex min-h-0 flex-col gap-3 text-left">
            <ul
              ref={observeListOverflow}
              aria-label="Checkouts to remove"
              tabIndex={listOverflows ? 0 : undefined}
              className="max-h-60 min-h-0 divide-y divide-border/60 overflow-y-auto overscroll-contain rounded-lg border border-border/60 bg-muted/40 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {members.map((member) => {
                const key = member.physicalProjectKey;
                return (
                  <li
                    key={key}
                    ref={
                      failure?.member.physicalProjectKey === key
                        ? (row) => row?.scrollIntoView({ block: "nearest" })
                        : undefined
                    }
                    className="flex min-w-0 items-center gap-3 px-3 py-2"
                  >
                    {machineRows ? (
                      <EnvironmentMachineIcon
                        aria-hidden
                        kind={resolveEnvironmentMachineKind(
                          environmentOf(member)?.serverConfig ?? null,
                        )}
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                    ) : (
                      <ProjectFavicon project={member} className="size-4 shrink-0" />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col">
                      {machineRows ? null : (
                        <span className="truncate text-sm font-medium">
                          {members.length > 1 || isCheckout ? member.title : group.displayName}
                        </span>
                      )}
                      {/* Wraps, since its suffix can be what tells same-named machines apart. */}
                      {showMachines ? (
                        <span
                          className={cn(
                            "wrap-anywhere",
                            machineRows ? "text-sm font-medium" : "text-xs text-muted-foreground",
                          )}
                        >
                          {machineName(member)}
                        </span>
                      ) : null}
                      <span className="text-xs wrap-anywhere text-muted-foreground">
                        {member.workspaceRoot}
                      </span>
                    </span>
                    {removedKeys.has(key) ? (
                      <span className="shrink-0 text-xs text-muted-foreground">Removed</span>
                    ) : failure?.member.physicalProjectKey === key ? (
                      <span className="shrink-0 text-xs text-destructive-foreground">Failed</span>
                    ) : failure && touchedKeys.has(key) ? (
                      <span className="shrink-0 text-xs text-destructive-foreground">
                        Incomplete
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {failureMessage ? (
              <Alert variant="error">
                <CircleAlertIcon aria-hidden />
                <AlertDescription>
                  <p>{failureMessage}</p>
                  {failureNote ? <p>{failureNote}</p> : null}
                </AlertDescription>
              </Alert>
            ) : null}
            {offlineMachines.length > 0 ? (
              <Alert variant="warning" role="status">
                <UnplugIcon aria-hidden />
                <AlertDescription>
                  {`Connect ${new Intl.ListFormat("en").format(offlineMachines)} to remove ${
                    removedKeys.size > 0
                      ? "the rest"
                      : !isCheckout
                        ? "this project"
                        : members.length === 1
                          ? "this checkout"
                          : "these checkouts"
                  }.`}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose
            ref={cancelRef}
            render={<Button variant="outline" disabled={removing} />}
          >
            {touchedKeys.size > 0 ? "Close" : "Cancel"}
          </AlertDialogClose>
          <Button
            variant="destructive"
            disabled={removing || offlineMachines.length > 0}
            onClick={() => void remove()}
          >
            {removing ? <Spinner /> : null}
            {removing
              ? members.length > 1
                ? `Removing ${Math.min(removedKeys.size + 1, members.length)} of ${members.length}…`
                : "Removing…"
              : failure
                ? "Retry"
                : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
