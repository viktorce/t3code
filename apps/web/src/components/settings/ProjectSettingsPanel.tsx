import { useAtomValue } from "@effect/atom-react";
import { useComposerMenuState } from "../chat/useComposerMenuState";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useEnvironmentScopeStates } from "../../state/session";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import {
  planProjectRemoval,
  projectChangeWait,
  projectRemovalGrowth,
  projectRemovalReadiness,
  projectRemovalReconfirmation,
  projectRemovalWait,
} from "@t3tools/client-runtime/state/projects";
import { type EnvironmentId, type SidebarProjectGroupingMode } from "@t3tools/contracts";
import {
  checkProjectRemoval,
  useProjectGroupRemoval,
  useProjectGroupUpdate,
  type ProjectGroupUpdate,
} from "../../hooks/useProjectGroupUpdate";
import { Navigate, useLocation, useNavigate } from "@tanstack/react-router";
import { InfoIcon, Trash2Icon } from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import { persistClientSettingsUpdate, useClientSettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import {
  PROJECT_GROUPING_MODE_LABELS,
  withProjectGroupingOverride,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { readThreadShells } from "../../state/entities";
import { liveShellEnvironmentIdsAtom } from "../../state/shell";
import { ProjectFavicon } from "../ProjectFavicon";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { cn } from "~/lib/utils";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  canPickExternalProjectFavicon,
  ProjectFaviconPickerDialog,
} from "./ProjectFaviconPickerDialog";
import { ProjectActionsSettings } from "./ProjectActionsSettings";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import {
  defaultProjectIcon,
  hasDefaultProjectIcon,
  projectGroupTitleNeedsUpdate,
  SCRATCH_PROJECT_TITLE,
} from "./ProjectSettingsPanel.logic";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { readUnloadedThreadCount } from "../../state/olderSettledShelf";
import { PROJECT_CHECKOUTS_SECTION_ID } from "./settingsScope";
import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";

const ProjectIconPickerDialog = lazy(() =>
  import("./ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

function isGroupingSelection(value: unknown): value is SidebarProjectGroupingMode | "inherit" {
  return (
    value === "inherit" ||
    value === "repository" ||
    value === "repository_path" ||
    value === "separate"
  );
}

// Grouping overrides are client settings, so they stay editable without project write access.
function CheckoutGroupingSelect({ member }: { member: SidebarProjectGroupMember }) {
  const overrideKey = derivePhysicalProjectKey(member);
  const globalMode = useClientSettings((settings) => settings.sidebarProjectGroupingMode);
  const selection = useClientSettings(
    (settings) => settings.sidebarProjectGroupingOverrides?.[overrideKey] ?? "inherit",
  );
  return (
    <Select
      value={selection}
      onValueChange={(value) => {
        if (!isGroupingSelection(value)) return;
        persistClientSettingsUpdate((current) => ({
          ...current,
          sidebarProjectGroupingOverrides: withProjectGroupingOverride(
            current.sidebarProjectGroupingOverrides,
            overrideKey,
            value,
          ),
        })).catch((error) => {
          console.error("Failed to save checkout grouping rule", error);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not save grouping rule",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        });
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={`Grouping rule for ${member.workspaceRoot} on ${
          member.environmentLabel
            ? `${member.environmentLabel} (${member.environmentId})`
            : member.environmentId
        }`}
      >
        <SelectValue>
          {selection === "inherit"
            ? `Default (${PROJECT_GROUPING_MODE_LABELS[globalMode]})`
            : PROJECT_GROUPING_MODE_LABELS[selection]}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value="inherit">
          Use global default
        </SelectItem>
        <SelectItem hideIndicator value="repository">
          {PROJECT_GROUPING_MODE_LABELS.repository}
        </SelectItem>
        <SelectItem hideIndicator value="repository_path">
          {PROJECT_GROUPING_MODE_LABELS.repository_path}
        </SelectItem>
        <SelectItem hideIndicator value="separate">
          {PROJECT_GROUPING_MODE_LABELS.separate}
        </SelectItem>
      </SelectPopup>
    </Select>
  );
}

export type ProjectSettingsCategory = "general" | "source-control" | "project";

interface ProjectSelection {
  readonly key: string;
  readonly environmentId: EnvironmentId | null;
  readonly checkoutKey: string | null;
  readonly memberKeys: ReadonlyArray<string>;
}

function sameProjectSelection(a: ProjectSelection | null, b: ProjectSelection): boolean {
  return (
    a !== null &&
    a.key === b.key &&
    a.environmentId === b.environmentId &&
    a.checkoutKey === b.checkoutKey &&
    a.memberKeys.length === b.memberKeys.length &&
    a.memberKeys.every((key, index) => key === b.memberKeys[index])
  );
}

const NOTHING_REMOVING: ReadonlySet<string> = new Set();

export function ProjectSettingsPanel({
  projectKey,
  environmentId = null,
  checkoutKey = null,
  unavailable,
}: {
  projectKey: string;
  environmentId?: EnvironmentId | null;
  checkoutKey?: string | null;
  unavailable?: ReactNode;
}) {
  const groups = useSettingsProjectGroups();
  const pathname = useLocation({ select: (location) => location.pathname });

  const selected = groups.find((group) => group.projectKey === projectKey) ?? null;
  const members =
    selected?.memberProjects.filter(
      (member) =>
        (environmentId === null || member.environmentId === environmentId) &&
        (checkoutKey === null || member.physicalProjectKey === checkoutKey),
    ) ?? [];

  // Retain group members so grouping-rule changes can follow the project to its new group.
  const [lastSelection, setLastSelection] = useState<ProjectSelection | null>(null);
  if (selected && members.length > 0) {
    const current: ProjectSelection = {
      key: selected.projectKey,
      environmentId,
      checkoutKey,
      memberKeys: members.map((member) => member.physicalProjectKey),
    };
    if (!sameProjectSelection(lastSelection, current)) setLastSelection(current);
  }
  // Held here, not in the detail, because the scope pickers remount the detail. A checkout stays in
  // until the list drops it, so a list that lags behind the server still shows it going.
  const [removing, setRemoving] = useState<ReadonlySet<string>>(NOTHING_REMOVING);
  const listed = new Set(
    groups.flatMap((group) => group.memberProjects.map((member) => member.physicalProjectKey)),
  );
  if ([...removing].some((key) => !listed.has(key))) {
    setRemoving(new Set([...removing].filter((key) => listed.has(key))));
  }
  const successor =
    members.length === 0 &&
    lastSelection?.key === projectKey &&
    lastSelection.environmentId === environmentId &&
    lastSelection.checkoutKey === checkoutKey
      ? groups.find((group) =>
          group.memberProjects.some((member) =>
            lastSelection.memberKeys.includes(member.physicalProjectKey),
          ),
        )
      : undefined;
  // The project a removal here went through on. Once it's gone, however many removals that took and
  // whichever scope is picked, the page goes back to the list. A checkout that joined meanwhile keeps
  // the project, and one that moved to another project takes the page with it.
  const [removedProject, setRemovedProject] = useState<string | null>(null);
  const leaving = removedProject === projectKey && selected === null && successor === undefined;
  const scopeKey = `${projectKey}:${environmentId ?? "all"}:${checkoutKey ?? "all"}`;
  const navigate = useNavigate({ from: "/settings" });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the router lives outside React
  useEffect(() => {
    if (!leaving) return;
    void navigate({
      to: "/settings/projects",
      search: ({ machine }) => ({ project: undefined, machine, checkout: undefined }),
      replace: true,
    });
  }, [leaving, navigate]);
  if (successor) {
    return (
      <Navigate
        to={pathname}
        search={{
          project: successor.projectKey,
          machine: environmentId ?? undefined,
          checkout: checkoutKey ?? undefined,
        }}
        replace
        hashScrollIntoView={false}
      />
    );
  }

  if ((!selected || members.length === 0) && unavailable != null) return unavailable;

  if (!selected) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        {groups.length === 0
          ? "Add a project from the sidebar to configure it here."
          : "This project is no longer available."}
      </div>
    );
  }
  if (members.length === 0)
    return (
      <p className="p-8 text-sm text-muted-foreground">
        This checkout is no longer available in the selected project and environment.
      </p>
    );
  const scopedGroup = {
    ...selected,
    memberProjects: members,
    environmentId: members[0]!.environmentId,
    id: members[0]!.id,
  };
  return (
    <ProjectDetail
      key={scopeKey}
      group={scopedGroup}
      allMembers={selected.memberProjects}
      hasOtherMembers={members.length < selected.memberProjects.length}
      removing={removing}
      onRemovingChange={setRemoving}
      onRemoved={() => setRemovedProject(projectKey)}
    />
  );
}

function ProjectDetail({
  group,
  allMembers,
  hasOtherMembers,
  removing,
  onRemovingChange: setRemoving,
  onRemoved,
}: {
  group: SidebarProjectSnapshot;
  /** Pin and archive belong to the whole project, even when one machine is picked. */
  allMembers: ReadonlyArray<SidebarProjectGroupMember>;
  hasOtherMembers: boolean;
  /**
   * Checkouts being removed, by key. A Remove that covers any of them waits, so a slow machine
   * can't take a second try at the same checkouts.
   */
  removing: ReadonlySet<string>;
  onRemovingChange: Dispatch<SetStateAction<ReadonlySet<string>>>;
  onRemoved: () => void;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  // A machine that hasn't connected since the app started has no session to grant or refuse yet.
  const scopeStates = useEnvironmentScopeStates(allMembers, AuthOrchestrationOperateScope);
  // A machine that reconnects reloads its threads, which a removal's confirmation counts.
  const liveEnvironmentIds = useAtomValue(liveShellEnvironmentIdsAtom);
  // A shared edit writes to every checkout, so it waits for all of them, in the removal rows' order.
  // It counts no threads, so it doesn't wait for them.
  const writeWait = (members: ReadonlyArray<SidebarProjectGroupMember>) =>
    projectChangeWait(
      members,
      (member) =>
        projectRemovalReadiness(
          environmentById.get(member.environmentId),
          scopeStates.get(member.environmentId) ?? "unknown",
          true,
        ),
      (member) => member.environmentLabel ?? "the selected environment",
    );
  const editWait = writeWait(group.memberProjects);
  const canEditGroup = editWait === null;
  const nameFieldKey = `${group.projectKey}:${group.displayName}:${canEditGroup}`;
  // Pin and archive cover the whole project, even when one machine is picked.
  const organizeWait = writeWait(allMembers);
  const representative =
    group.memberProjects.find(
      (member) => environmentById.get(member.environmentId)?.serverConfig != null,
    ) ?? group.memberProjects[0]!;
  const { removeProjectMembers } = useProjectGroupRemoval();
  // The name field that was edited. A wait remounts it, so an edit abandoned then never counts.
  const projectNameEditedRef = useRef<HTMLInputElement | null>(null);

  const faviconPath = representative.faviconPath ?? null;
  const projectIcon = representative.projectIcon ?? null;
  const pickProjectFavicon =
    typeof window !== "undefined" &&
    group.memberProjects.every(
      (member) =>
        member.environmentId === primaryEnvironmentId &&
        canPickExternalProjectFavicon(member.workspaceRoot, navigator.platform),
    )
      ? window.desktopBridge?.pickProjectFavicon
      : undefined;

  const { updateProjectGroup, canOrganizeProjectGroup } = useProjectGroupUpdate();
  const updateAllMembers = (
    input: ProjectGroupUpdate | ((member: SidebarProjectGroupMember) => ProjectGroupUpdate),
    failureTitle: string,
  ) => updateProjectGroup(group.memberProjects, input, failureTitle);
  // With one machine picked, a reason can name another, so the rows say why it matters.
  const everyCheckout = hasOtherMembers ? " This applies to every checkout." : "";
  // Only a server known to lack pin and archive hides them. One not reached since the app started
  // may well have them, so the rows wait for it and say why, as on mobile.
  const canOrganize = canOrganizeProjectGroup(
    allMembers.filter((member) => environmentById.get(member.environmentId)?.serverConfig != null),
  );
  const [isOrganizing, setIsOrganizing] = useState(false);
  const organize = async (input: ProjectGroupUpdate, failureTitle: string) => {
    setIsOrganizing(true);
    await updateProjectGroup(allMembers, input, failureTitle);
    setIsOrganizing(false);
  };

  const renameGroup = async (nextTitle: string, wasEdited: boolean) => {
    const title = nextTitle.trim();
    if (!title) {
      toastManager.add({ type: "warning", title: "Project title cannot be empty" });
      return;
    }
    if (
      !projectGroupTitleNeedsUpdate(
        group.memberProjects.map((member) => member.title),
        title,
        wasEdited,
      )
    ) {
      return;
    }
    await updateAllMembers({ title }, "Failed to rename project");
  };

  const [faviconPickerOpen, setFaviconPickerOpen] = useComposerMenuState(!canEditGroup);
  const [iconPickerOpen, setIconPickerOpen] = useComposerMenuState(!canEditGroup);
  const [isSavingFavicon, setIsSavingFavicon] = useState(false);
  const savingFaviconRef = useRef(false);
  const setProjectIcon = async (input: Parameters<typeof updateAllMembers>[0]) => {
    if (savingFaviconRef.current) return;
    savingFaviconRef.current = true;
    setIsSavingFavicon(true);
    await updateAllMembers(input, "Failed to update project icon");
    savingFaviconRef.current = false;
    setIsSavingFavicon(false);
  };

  const hasMultipleCheckouts = group.memberProjects.length > 1;
  // A scope can hold one checkout or several machines' worth.
  const removeCheckoutsLabel =
    group.memberProjects.length === 1
      ? "Remove checkout"
      : `Remove ${group.memberProjects.length} checkouts`;
  const removeAllLabel = hasOtherMembers
    ? removeCheckoutsLabel
    : group.memberProjects.length === 2
      ? "Remove both checkouts"
      : group.memberProjects.length > 2
        ? `Remove all ${group.memberProjects.length} checkouts`
        : "Remove project";
  // The label "Removing…" covers, kept from the press. As checkouts go, the live one shortens, and
  // the button would shrink under the pointer.
  const [heldLabel, setHeldLabel] = useState<string | null>(null);
  // Why a removal can't run; removeMembers still refuses a machine that drops first.
  const removalWait = (members: ReadonlyArray<SidebarProjectGroupMember>) =>
    projectRemovalWait(
      members,
      (member) =>
        projectRemovalReadiness(
          environmentById.get(member.environmentId),
          scopeStates.get(member.environmentId) ?? "unknown",
          liveEnvironmentIds.has(member.environmentId),
        ),
      (member) => member.environmentLabel ?? "the selected environment",
    );
  const removeAllWait = removalWait(group.memberProjects);
  const canResetScratchTitle =
    group.memberProjects.every((member) => member.isScratch) &&
    group.memberProjects.some((member) => member.title !== SCRATCH_PROJECT_TITLE);

  const isRemoving = (member: SidebarProjectGroupMember) => removing.has(member.physicalProjectKey);
  // Read from the live list, which drops each checkout as its removal commits, so this holds
  // until the last one goes.
  const removingAll = group.memberProjects.every(isRemoving);
  const removingAny = group.memberProjects.some(isRemoving);
  const removeMembers = async (members: ReadonlyArray<SidebarProjectGroupMember>) => {
    // Remove stays focusable while one runs, so a press on the same checkouts is turned away here.
    if (members.some(isRemoving)) return;
    // A machine that dropped keeps its grant, so its Remove looks ready; refuse before confirming.
    if (checkProjectRemoval(members, "Failed to remove project")) return;
    const api = readLocalApi();
    if (!api) return;

    // Planned from the threads as they are now: a confirmation can wait while threads start or appear.
    const planNow = () => {
      const threads = readThreadShells();
      return planProjectRemoval({
        members,
        groupMemberCount: group.memberProjects.length,
        hasOtherMembers,
        displayName: group.displayName,
        threads,
        unloadedThreadCount: readUnloadedThreadCount(members, threads),
      });
    };
    let plan = planNow();
    let message = plan.confirmationMessage;
    for (;;) {
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(message, { variant: "destructive" }),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;
      // A machine that dropped or started reloading meanwhile refuses before any second question.
      if (checkProjectRemoval(members, "Failed to remove project")) return;
      const now = planNow();
      const growth = projectRemovalGrowth(plan, now);
      plan = now;
      if (growth === null) break;
      // A thread to delete or stop that the answer didn't cover needs its own answer.
      message = projectRemovalReconfirmation(now, growth);
    }
    const keys = members.map((member) => member.physicalProjectKey);
    setRemoving((current) => new Set([...current, ...keys]));
    if (members.length === group.memberProjects.length) setHeldLabel(removeAllLabel);
    const removed = await settlePromise(() => removeProjectMembers(members, plan.projectThreads));
    setHeldLabel(null);
    if (removed._tag === "Failure" || removed.value === "failed") {
      // What's still listed can be tried again. The rest goes as the list drops it.
      setRemoving((current) => new Set([...current].filter((key) => !keys.includes(key))));
      return;
    }
    onRemoved();
  };

  const checkoutsByEnvironment = new Map<EnvironmentId, SidebarProjectGroupMember[]>();
  for (const member of group.memberProjects) {
    const members = checkoutsByEnvironment.get(member.environmentId);
    if (members) members.push(member);
    else checkoutsByEnvironment.set(member.environmentId, [member]);
  }
  // A lone checkout is removed from the Danger section, but it still needs its grouping
  // rule here so "Keep separate" can be undone.
  const checkoutControls = (member: SidebarProjectGroupMember) => (
    <div className="flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:w-auto">
      <div className="min-w-0 flex-1 @min-[32rem]/settings-row:w-72 @min-[32rem]/settings-row:flex-none">
        <CheckoutGroupingSelect member={member} />
      </div>
      {hasMultipleCheckouts ? (
        <Button
          size="sm"
          variant="outline"
          disabled={removalWait([member]) !== null}
          // Unlike disabled, keeps focus here while a removal runs, for the confirm to return it.
          aria-disabled={isRemoving(member) || undefined}
          onClick={() => void removeMembers([member])}
          aria-label={`Remove checkout ${member.workspaceRoot}`}
        >
          {/* Both labels share one cell, so the button and the select beside it stay put. */}
          <span className="grid justify-items-center">
            <span
              className={cn(
                "col-start-1 row-start-1",
                isRemoving(member) && !removingAll && "invisible",
              )}
            >
              Remove
            </span>
            <span
              className={cn(
                "col-start-1 row-start-1",
                !(isRemoving(member) && !removingAll) && "invisible",
              )}
            >
              Removing…
            </span>
          </span>
        </Button>
      ) : null}
    </div>
  );
  const checkoutChoices = (
    <SettingsSection id={PROJECT_CHECKOUTS_SECTION_ID} title="Checkouts">
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        Grouping rule decides how each checkout joins project groups in the sidebar. Changing it can
        move a checkout to a different project.
      </p>
      {Array.from(checkoutsByEnvironment, ([environmentId, members]) => {
        if (checkoutsByEnvironment.size === 1) {
          return members.map((member) => (
            <SettingsRow
              key={member.physicalProjectKey}
              title={member.environmentLabel ?? "Environment"}
              description={member.workspaceRoot}
              status={hasMultipleCheckouts ? removalWait([member]) : null}
              control={checkoutControls(member)}
            />
          ));
        }
        const firstMember = members[0]!;
        const hasMultiple = members.length > 1;
        const environment = environmentById.get(environmentId);
        const labels = environment
          ? settingsScopeEnvironmentLabels(environment, environments)
          : { primary: firstMember.environmentLabel ?? "Environment", secondary: environmentId };
        return (
          <SettingsRow
            key={environmentId}
            title={labels.primary}
            description={
              <>
                {labels.secondary ? (
                  <span className="block truncate">{labels.secondary}</span>
                ) : null}
                {!hasMultiple ? (
                  <Tooltip>
                    <TooltipTrigger render={<span className="block truncate" />}>
                      {firstMember.workspaceRoot}
                    </TooltipTrigger>
                    <TooltipPopup>{firstMember.workspaceRoot}</TooltipPopup>
                  </Tooltip>
                ) : null}
              </>
            }
            status={removalWait(members)}
            control={hasMultiple ? undefined : checkoutControls(firstMember)}
          >
            {hasMultiple ? (
              <div className="space-y-3 pb-2 pt-1">
                {members.map((member) => (
                  <div
                    key={member.physicalProjectKey}
                    className="flex min-w-0 flex-col gap-1.5 @min-[36rem]/settings-row:flex-row @min-[36rem]/settings-row:items-center @min-[36rem]/settings-row:justify-between @min-[36rem]/settings-row:gap-3"
                  >
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="min-w-0 max-w-full truncate text-xs text-muted-foreground/80" />
                        }
                      >
                        {member.workspaceRoot}
                      </TooltipTrigger>
                      <TooltipPopup>{member.workspaceRoot}</TooltipPopup>
                    </Tooltip>
                    <div className="shrink-0">{checkoutControls(member)}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );

  return (
    <>
      <SettingsPageContainer className="gap-6">
        <Alert variant="info">
          <InfoIcon aria-hidden />
          <AlertDescription>
            Can't find a setting? Keep this project picked above and hop to any other settings page.
          </AlertDescription>
        </Alert>
        <SettingsSection id="project-overview" title="Project" hideTitle>
          {editWait ? (
            <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">{editWait}</p>
          ) : null}
          <SettingsRow
            title="Name"
            description="The shared name for this project group in the sidebar and thread lists."
            resetAction={
              canResetScratchTitle ? (
                <SettingResetButton
                  label="project name"
                  disabled={!canEditGroup}
                  onClick={() =>
                    void updateAllMembers(
                      { title: SCRATCH_PROJECT_TITLE },
                      "Failed to rename project",
                    )
                  }
                />
              ) : null
            }
            control={
              <Input
                // A wait that starts mid-edit brings the saved name back: Chromium takes focus off
                // a newly disabled input without a blur, so the edit would sit there unsaved.
                key={nameFieldKey}
                size="sm"
                className="w-full sm:w-64"
                aria-label="Project name"
                disabled={!canEditGroup}
                defaultValue={group.displayName}
                onChange={(event) => {
                  projectNameEditedRef.current = event.currentTarget;
                }}
                onBlur={(event) => {
                  const wasEdited = projectNameEditedRef.current === event.currentTarget;
                  projectNameEditedRef.current = null;
                  void renameGroup(event.currentTarget.value, wasEdited);
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            }
          />
          <SettingsRow
            title="Project icon"
            description={
              projectIcon?.kind === "lucide"
                ? `${projectIcon.name} · ${projectIcon.color}`
                : projectIcon?.kind === "monogram"
                  ? `${projectIcon.text} · ${projectIcon.color}`
                  : projectIcon?.kind === "emoji"
                    ? projectIcon.emoji
                    : (faviconPath ?? "Automatic")
            }
            resetAction={
              group.memberProjects.some((member) => !hasDefaultProjectIcon(member)) ? (
                <SettingResetButton
                  label="project icon"
                  disabled={isSavingFavicon || !canEditGroup}
                  onClick={() => void setProjectIcon(defaultProjectIcon)}
                />
              ) : null
            }
            control={
              <div className="flex items-center gap-2">
                <ProjectFavicon project={representative} className="size-6" />
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label="Choose a project icon"
                  disabled={isSavingFavicon || !canEditGroup}
                  onClick={() => setIconPickerOpen(true)}
                >
                  Choose icon
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label="Choose a project icon file"
                  disabled={isSavingFavicon || !canEditGroup}
                  onClick={() => setFaviconPickerOpen(true)}
                >
                  Choose file
                </Button>
              </div>
            }
          />
          {canOrganize ? (
            <>
              <SettingsRow
                title="Pin"
                description={`Pinned projects come first in project pickers.${everyCheckout}`}
                // Unless the note above already says the same.
                status={organizeWait !== editWait ? organizeWait : null}
                control={
                  <Switch
                    checked={group.pinned}
                    disabled={isOrganizing || organizeWait !== null}
                    onCheckedChange={(checked) =>
                      void organize(
                        { pinned: Boolean(checked) },
                        checked ? "Failed to pin project" : "Failed to unpin project",
                      )
                    }
                    aria-label="Pin project"
                  />
                }
              />
              <SettingsRow
                title="Archive"
                status={organizeWait !== editWait ? organizeWait : null}
                description={
                  (group.archived
                    ? "Hidden from project pickers. Threads and files are kept."
                    : "Hides the project from project pickers. Threads and files are kept.") +
                  everyCheckout
                }
                control={
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isOrganizing || organizeWait !== null}
                    onClick={() =>
                      void organize(
                        { archived: !group.archived },
                        group.archived
                          ? "Failed to unarchive project"
                          : "Failed to archive project",
                      )
                    }
                  >
                    {group.archived ? "Unarchive" : "Archive"}
                  </Button>
                }
              />
            </>
          ) : null}
        </SettingsSection>
        <ProjectDefaultsSettings category="project" />
        <ProjectActionsSettings />
        {checkoutChoices}
        <SettingsSection title="Danger">
          <span role="status" className="sr-only">
            {removingAny ? "Removing…" : ""}
          </span>
          <SettingsRow
            title={
              hasOtherMembers
                ? removeCheckoutsLabel
                : group.memberProjects.length > 1
                  ? "Remove this project everywhere"
                  : "Remove project"
            }
            description={
              hasOtherMembers
                ? `Deletes the selected checkout ${group.memberProjects.length === 1 ? "entry and its threads. Its folder stays" : "entries and their threads. Their folders stay"} on disk, and the project keeps its other checkouts.`
                : group.memberProjects.length > 1
                  ? `Deletes ${group.memberProjects.length === 2 ? "both" : `all ${group.memberProjects.length}`} checkout entries and their threads on every machine. Their folders stay on disk.`
                  : "Deletes the project entry and its threads. The project folder stays on disk."
            }
            status={removeAllWait}
            control={
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={removeAllWait !== null}
                aria-disabled={removingAny || undefined}
                onClick={() => void removeMembers(group.memberProjects)}
              >
                <span className="grid justify-items-center">
                  <span
                    aria-hidden={removingAll}
                    className={cn(
                      "col-start-1 row-start-1 inline-flex items-center gap-2",
                      removingAll && "invisible",
                    )}
                  >
                    <Trash2Icon />
                    {removingAll && heldLabel !== null ? heldLabel : removeAllLabel}
                  </span>
                  <span
                    aria-hidden={!removingAll}
                    className={cn(
                      "col-start-1 row-start-1 inline-flex items-center gap-2",
                      !removingAll && "invisible",
                    )}
                  >
                    <Spinner aria-hidden />
                    Removing…
                  </span>
                </span>
              </Button>
            }
          />
        </SettingsSection>
      </SettingsPageContainer>

      <ProjectFaviconPickerDialog
        key={`${representative.environmentId}:${representative.workspaceRoot}:${faviconPickerOpen}`}
        cwd={representative.workspaceRoot}
        environmentId={representative.environmentId}
        onOpenChange={setFaviconPickerOpen}
        {...(pickProjectFavicon
          ? { onPickExternal: () => pickProjectFavicon(representative.workspaceRoot) }
          : {})}
        onSelect={(path) => void setProjectIcon({ faviconPath: path, projectIcon: null })}
        open={faviconPickerOpen && canEditGroup}
        projectName={group.displayName}
      />
      {iconPickerOpen && canEditGroup ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            current={projectIcon}
            projectName={representative.title}
            open
            onOpenChange={setIconPickerOpen}
            onSelect={(icon) => void setProjectIcon({ faviconPath: null, projectIcon: icon })}
          />
        </Suspense>
      ) : null}
    </>
  );
}
