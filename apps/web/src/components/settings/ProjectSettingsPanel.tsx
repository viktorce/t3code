import { useComposerMenuState } from "../chat/useComposerMenuState";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import { mapAtomCommandResult, settlePromise } from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { planProjectRemoval } from "@t3tools/client-runtime/state/projects";
import { type EnvironmentId, type SidebarProjectGroupingMode } from "@t3tools/contracts";
import {
  checkProjectAccess,
  reportProjectFailure,
  useProjectGroupUpdate,
  type ProjectGroupUpdate,
} from "../../hooks/useProjectGroupUpdate";
import { Link, Navigate, useLocation, useNavigate } from "@tanstack/react-router";
import { Trash2Icon } from "lucide-react";
import { Fragment, lazy, Suspense, useId, useRef, useState, type ReactNode } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
import { persistClientSettingsUpdate, useClientSettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import {
  deriveProjectGroupLabel,
  derivePhysicalProjectKey,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  PROJECT_GROUPING_MODE_LABELS,
  withProjectGroupingOverride,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import { useThreadShells, waitForProjectRemoval } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { projectIconColorLabel, projectIconNameLabel } from "../../projectIconColors";
import { formatWorktreePathForDisplay } from "../../worktreeCleanup";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
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
import {
  projectScopeMenuGroups,
  settingsScopeEnvironmentLabel,
  settingsScopeEnvironmentLabels,
  settingsScopeProjectDistinction,
  settingsScopeProjectPath,
  settingsScopeSameNameProjects,
} from "./settingsScopeAxis";
import { PathText } from "./PathText";
import { projectListSearch } from "./settingsScopeNavigation";
import { PROJECT_OVERRIDE_PATHS, SETTINGS_SECTION_LABELS } from "./settingsSearch";

const ProjectIconPickerDialog = lazy(() =>
  import("./ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

const ORGANIZE_SEARCH_FALLBACKS = {
  "project-pin": "project-overview",
  "project-archive": "project-overview",
};

// The "More settings" link a project's page was left by, keyed by its history entry so going Back
// to that entry restores where the link was, the way the project list restores the row it was left by.
let leftByLink:
  | { link: HTMLElement; visit: string | undefined; path: string; scrollTop: number }
  | undefined;

// Going Back puts the link where it was and gives it the focus the page change dropped. A page
// opened for a search target scrolls to that instead.
function returnToLink(
  link: HTMLElement | null,
  path: string,
  visit: string | undefined,
  hash: string,
) {
  const left = leftByLink;
  // Router links re-attach their ref on every render, so the clicked link itself is skipped:
  // only the page come back to has a new one.
  if (!link || !left || left.link === link || left.visit !== visit || left.path !== path || hash)
    return;
  const scroller = link.closest<HTMLElement>("[data-settings-page-scroll]");
  if (scroller) scroller.scrollTop = left.scrollTop;
  leftByLink = undefined;
  if (document.activeElement === document.body) link.focus({ preventScroll: true });
}

function isGroupingSelection(value: unknown): value is SidebarProjectGroupingMode | "inherit" {
  return (
    value === "inherit" ||
    value === "repository" ||
    value === "repository_path" ||
    value === "separate"
  );
}

/** A checkout's accessible name: its path, plus its environment when there are several. */
function checkoutName(
  member: SidebarProjectGroupMember,
  environments: readonly EnvironmentPresentation[],
) {
  if (environments.length <= 1) return member.workspaceRoot;
  const environment = environments.find((entry) => entry.environmentId === member.environmentId);
  return `${member.workspaceRoot} on ${
    environment
      ? settingsScopeEnvironmentLabel(environment, environments)
      : (member.environmentLabel ?? member.environmentId)
  }`;
}

// Grouping overrides are client settings, so they stay editable without project write access.
function CheckoutGroupingSelect({ member }: { member: SidebarProjectGroupMember }) {
  const overrideKey = derivePhysicalProjectKey(member);
  const { environments } = useEnvironments();
  const globalMode = useClientSettings((settings) => settings.sidebarProjectGroupingMode);
  const defaultLabel = `Default (${PROJECT_GROUPING_MODE_LABELS[globalMode]})`;
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
        aria-label={`Grouping rule for ${checkoutName(member, environments)}`}
      >
        <SelectValue>
          {selection === "inherit" ? defaultLabel : PROJECT_GROUPING_MODE_LABELS[selection]}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value="inherit">
          {defaultLabel}
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
  const { environments } = useEnvironments();
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

  // The projects page explains a missing project or checkout, so this panel adds no copy of its own.
  if (!selected || members.length === 0) return unavailable ?? null;
  const scopedGroup = {
    ...selected,
    // Name edits reach only the picked checkouts, so the field shows their name, as on mobile.
    displayName:
      members.length < selected.memberProjects.length
        ? deriveProjectGroupLabel({ representative: members[0]!, members })
        : selected.displayName,
    memberProjects: members,
    environmentId: members[0]!.environmentId,
    id: members[0]!.id,
  };
  // Projects that share a name are told apart the way the list and the picker tell them apart.
  const distinction = settingsScopeProjectDistinction(
    selected,
    groups,
    environments,
    environmentId ?? undefined,
  );
  const others = settingsScopeSameNameProjects(selected, groups).length;
  const sameName =
    distinction === null ? null : (
      <>
        {`${others === 1 ? "Another project is" : `${others} other projects are`} also named "${selected.displayName}". This one is `}
        {distinction === settingsScopeProjectPath(selected, environmentId ?? undefined) ? (
          // Quoted like the name, so the closing period is not read as part of the path.
          <>
            at "<PathText text={distinction} />
            ".
          </>
        ) : (
          `on ${distinction}.`
        )}
      </>
    );
  // The row after this one on the list, else the one before, takes its place once it is removed.
  const listed = projectScopeMenuGroups(groups, { machine: environmentId ?? undefined });
  const listIndex = listed.findIndex((group) => group.projectKey === selected.projectKey);
  const listNeighbor = (listed[listIndex + 1] ?? listed[listIndex - 1])?.projectKey;
  return (
    <ProjectDetail
      key={`${selected.projectKey}:${environmentId ?? "all"}:${checkoutKey ?? "all"}`}
      group={scopedGroup}
      allMembers={selected.memberProjects}
      hasOtherMembers={members.length < selected.memberProjects.length}
      checkoutPicked={checkoutKey !== null}
      sameName={sameName}
      listNeighbor={listNeighbor}
    />
  );
}

function ProjectDetail({
  group,
  allMembers,
  hasOtherMembers,
  checkoutPicked,
  sameName,
  listNeighbor,
}: {
  group: SidebarProjectSnapshot;
  /** Pin and archive belong to the whole project, even when one machine is picked. */
  allMembers: ReadonlyArray<SidebarProjectGroupMember>;
  hasOtherMembers: boolean;
  checkoutPicked: boolean;
  sameName: ReactNode;
  listNeighbor: string | undefined;
}) {
  const noteId = useId();
  const navigate = useNavigate({ from: "/settings" });
  const hash = useLocation({ select: (location) => location.hash });
  const visit = useLocation({ select: (location) => location.state.__TSR_key });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const editableIds = useEnvironmentsWithScope(allMembers, AuthOrchestrationOperateScope);
  const canEditGroup = group.memberProjects.every((member) =>
    editableIds.has(member.environmentId),
  );
  const representative =
    group.memberProjects.find(
      (member) => environmentById.get(member.environmentId)?.serverConfig != null,
    ) ?? group.memberProjects[0]!;
  const threads = useThreadShells();
  const deleteProject = useOrchestrationCommand(projectEnvironment.delete, {
    reportFailure: false,
  });
  // The name field restarts from the saved name when that name or edit access changes; losing
  // access disables a focused field without a blur. An edit counts only for the field it was in.
  const nameFieldKey = `${group.projectKey}:${group.displayName}:${canEditGroup}`;
  const projectNameEditedRef = useRef<string | null>(null);

  const faviconPath = representative.faviconPath ?? null;
  const projectIcon = representative.projectIcon ?? null;
  const iconKey = (member: SidebarProjectGroupMember) =>
    JSON.stringify([member.projectIcon ?? null, member.faviconPath ?? null]);
  // One checkout per distinct icon; more than one means the checkouts disagree.
  const iconMembers = group.memberProjects.filter(
    (member, index, members) =>
      members.findIndex((other) => iconKey(other) === iconKey(member)) === index,
  );
  const mixedIcons = iconMembers.length > 1;
  const scopeEnvironment = environmentById.get(representative.environmentId);
  const scopeEnvironmentLabel = scopeEnvironment
    ? settingsScopeEnvironmentLabel(scopeEnvironment, environments)
    : "the selected environment";
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
  const canOrganize =
    allMembers.every((member) => editableIds.has(member.environmentId)) &&
    canOrganizeProjectGroup(allMembers);
  const [isOrganizing, setIsOrganizing] = useState(false);
  const organize = async (input: ProjectGroupUpdate, failureTitle: string) => {
    setIsOrganizing(true);
    await updateProjectGroup(allMembers, input, failureTitle);
    setIsOrganizing(false);
  };

  /** False when the name was refused, so the field can show the saved one again. */
  const renameGroup = async (nextTitle: string, wasEdited: boolean) => {
    const title = nextTitle.trim();
    if (!title) {
      toastManager.add({ type: "warning", title: "Project name can't be empty" });
      return false;
    }
    if (
      !projectGroupTitleNeedsUpdate(
        group.memberProjects.map((member) => member.title),
        title,
        wasEdited,
      )
    ) {
      return true;
    }
    return (await updateAllMembers({ title }, "Failed to rename project"))._tag === "Success";
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
  const canResetScratchTitle =
    group.memberProjects.every((member) => member.isScratch) &&
    group.memberProjects.some((member) => member.title !== SCRATCH_PROJECT_TITLE);

  const removeMembers = async (members: ReadonlyArray<SidebarProjectGroupMember>) => {
    if (checkProjectAccess(members, "Failed to remove project")) return;
    const api = readLocalApi();
    if (!api) return;

    const { projectThreads, isWholeGroup, confirmationMessage } = planProjectRemoval({
      members,
      groupMemberCount: group.memberProjects.length,
      hasOtherMembers,
      displayName: group.displayName,
      threads,
      unloadedThreadCount: readUnloadedThreadCount(members, threads),
    });
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(confirmationMessage, { variant: "destructive" }),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;
    if (checkProjectAccess(members, "Failed to remove project")) return;

    const draftStore = useComposerDraftStore.getState();
    for (const member of members) {
      if (checkProjectAccess([member], "Failed to remove project")) return;
      const memberThreads = projectThreads.filter(
        (thread) => thread.environmentId === member.environmentId && thread.projectId === member.id,
      );
      const result = mapAtomCommandResult(
        await deleteProject({
          environmentId: member.environmentId,
          input: {
            projectId: member.id,
            force: true,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        reportProjectFailure(`Failed to remove "${member.title}"`, result);
        return;
      }
      const projectRef = scopeProjectRef(member.environmentId, member.id);
      await waitForProjectRemoval(projectRef);
      releaseProjectDraftUploads(
        projectRef,
        memberThreads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
      );
      const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
      if (projectDraftThread) {
        draftStore.clearDraftThread(projectDraftThread.draftId);
      }
      draftStore.clearProjectDraftThreadId(projectRef);
    }

    if (isWholeGroup && !hasOtherMembers) {
      // The page closes, so the toast is what confirms the removal.
      toastManager.add({ type: "success", title: `Removed ${group.displayName}` });
      void navigate({
        to: "/settings/projects",
        search: projectListSearch,
        replace: true,
        ...(listNeighbor ? { state: { settingsFocusProject: listNeighbor } } : {}),
      });
    }
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
          variant="ghost-destructive"
          disabled={!editableIds.has(member.environmentId)}
          onClick={() => void removeMembers([member])}
          aria-label={`Remove checkout ${checkoutName(member, environments)}`}
        >
          <Trash2Icon />
          Remove
        </Button>
      ) : null}
    </div>
  );
  // One name for the action, counted when an environment filter leaves several checkouts.
  const removeCount = group.memberProjects.length;
  const removeLabel = !hasOtherMembers
    ? "Remove project"
    : removeCount === 1
      ? "Remove checkout"
      : `Remove ${removeCount} checkouts`;
  const checkoutChoices = (
    // A checkout that is removed or regrouped away takes its controls with it, so focus stays
    // on the card instead of jumping to another checkout's matching control or the page's top.
    <SettingsSection
      id="project-checkouts"
      title="Checkouts"
      data-workspace-focus-fallback="project-checkouts"
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        Each checkout's grouping rule decides which project it joins in the sidebar. Changing it can
        move the checkout to another project.
      </p>
      {Array.from(checkoutsByEnvironment, ([environmentId, members]) => {
        if (checkoutsByEnvironment.size === 1) {
          // Checkouts on one machine share its name, so their folders tell them apart. A lone
          // checkout names its machine only when there are others to tell it from.
          return members.map((member) => (
            <SettingsRow
              key={member.physicalProjectKey}
              title={
                members.length > 1 || environments.length === 1
                  ? formatWorktreePathForDisplay(member.workspaceRoot)
                  : (member.environmentLabel ?? "Environment")
              }
              description={
                <span className="block wrap-anywhere">
                  <PathText text={member.workspaceRoot} />
                </span>
              }
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
                  <span className="block wrap-anywhere">
                    <PathText text={firstMember.workspaceRoot} />
                  </span>
                ) : null}
              </>
            }
            control={hasMultiple ? undefined : checkoutControls(firstMember)}
          >
            {hasMultiple ? (
              <div className="space-y-3 pb-2 pt-1">
                {members.map((member) => (
                  <div
                    key={member.physicalProjectKey}
                    className="flex min-w-0 flex-col gap-1.5 @min-[36rem]/settings-row:flex-row @min-[36rem]/settings-row:items-center @min-[36rem]/settings-row:justify-between @min-[36rem]/settings-row:gap-3"
                  >
                    <span className="min-w-0 text-xs wrap-anywhere text-muted-foreground/80">
                      <PathText text={member.workspaceRoot} />
                    </span>
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
      <SettingsPageContainer
        className="gap-6"
        // Without the Pin and Archive rows, their search results land on the card that says why.
        {...(canOrganize ? {} : { searchTargetFallbacks: ORGANIZE_SEARCH_FALLBACKS })}
      >
        {/* Focus lands here on opening a project, so screen readers announce its name, along
            with the notes that say which project this is. */}
        <SettingsSection
          id="project-overview"
          title={group.displayName}
          hideTitle
          aria-label={group.displayName}
          aria-describedby={
            [
              ...(group.isScratch ? [`${noteId}-scratch`] : []),
              ...(sameName ? [`${noteId}-same-name`] : []),
              ...(!canEditGroup || hasOtherMembers || !canOrganize ? [`${noteId}-access`] : []),
            ].join(" ") || undefined
          }
          data-workspace-focus-default
        >
          {group.isScratch ? (
            // Its default name, "No project", reads like no project being chosen.
            <p
              id={`${noteId}-scratch`}
              className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4"
            >
              These settings apply to threads started without a project.
            </p>
          ) : null}
          {sameName ? (
            <p
              id={`${noteId}-same-name`}
              className="px-3 py-2.5 text-xs wrap-anywhere text-muted-foreground sm:px-4"
            >
              {sameName}
            </p>
          ) : null}
          {!canEditGroup ? (
            <p
              id={`${noteId}-access`}
              className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4"
            >
              {group.memberProjects.length > 1
                ? "Shared settings require permission to change every checkout in this group."
                : "This connection cannot change this project."}
            </p>
          ) : hasOtherMembers || !canOrganize ? (
            <p
              id={`${noteId}-access`}
              className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4"
            >
              {[
                hasOtherMembers
                  ? checkoutPicked
                    ? "Name and icon change only for this checkout."
                    : `Name and icon change only on ${scopeEnvironmentLabel}.`
                  : null,
                canOrganize
                  ? "Pin and archive apply everywhere."
                  : allMembers.every((member) => editableIds.has(member.environmentId))
                    ? "Pin and archive need T3 Code to be updated on every environment with this project."
                    : "Pin and archive need permission to change every checkout of this project.",
              ]
                .filter(Boolean)
                .join(" ")}
            </p>
          ) : null}
          <SettingsRow
            id="project-name"
            title="Name"
            description="Shown in the sidebar and thread lists."
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
                key={nameFieldKey}
                size="sm"
                className="w-full sm:w-64"
                aria-label="Project name"
                disabled={!canEditGroup}
                defaultValue={group.displayName}
                onChange={() => {
                  projectNameEditedRef.current = nameFieldKey;
                }}
                onBlur={(event) => {
                  const input = event.currentTarget;
                  const wasEdited = projectNameEditedRef.current === nameFieldKey;
                  projectNameEditedRef.current = null;
                  const value = input.value;
                  // An empty name has nothing to correct, so the saved one shows again at once.
                  if (!value.trim()) input.value = group.displayName;
                  // Another refused name stays to be corrected while the field has focus.
                  void renameGroup(value, wasEdited).then((saved) => {
                    if (
                      !saved &&
                      projectNameEditedRef.current !== nameFieldKey &&
                      document.activeElement !== input
                    )
                      input.value = group.displayName;
                  });
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key !== "Enter") return;
                  // The blur saves the name; focus comes back so it is not left on the page.
                  const input = event.currentTarget;
                  input.blur();
                  input.focus({ preventScroll: true });
                }}
              />
            }
          />
          <SettingsRow
            id="project-icon"
            title="Icon"
            // Named the way the icon picker names them, not by their stored ids.
            description={
              mixedIcons
                ? "Differs between checkouts"
                : projectIcon?.kind === "lucide"
                  ? `${projectIconNameLabel(projectIcon.name)} · ${projectIconColorLabel(projectIcon.color)}`
                  : projectIcon?.kind === "monogram"
                    ? `${projectIcon.text} · ${projectIconColorLabel(projectIcon.color)}`
                    : projectIcon?.kind === "emoji"
                      ? `Emoji · ${projectIcon.emoji}`
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
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {mixedIcons ? (
                  // Up to three of the differing icons, so the choice shows what it replaces.
                  <span className="flex gap-1">
                    {iconMembers.slice(0, 3).map((member) => (
                      <ProjectFavicon
                        key={member.physicalProjectKey}
                        project={member}
                        className="size-6"
                      />
                    ))}
                  </span>
                ) : (
                  <ProjectFavicon project={representative} className="size-6" />
                )}
                {/* Both ways to pick an icon wrap together while they fit on one line. */}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    type="button"
                    disabled={isSavingFavicon || !canEditGroup}
                    onClick={() => setIconPickerOpen(true)}
                  >
                    Choose icon
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    type="button"
                    disabled={isSavingFavicon || !canEditGroup}
                    onClick={() => setFaviconPickerOpen(true)}
                    aria-label="Choose file for project icon"
                  >
                    Choose file
                  </Button>
                </div>
              </div>
            }
          />
          {canOrganize ? (
            <>
              <SettingsRow
                id="project-pin"
                title="Pin"
                description="Pinned projects come first in project pickers."
                control={
                  <Switch
                    checked={group.pinned}
                    disabled={isOrganizing}
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
                id="project-archive"
                title="Archive"
                description={
                  group.archived
                    ? "Hidden from project pickers. Threads and files are kept."
                    : "Hides the project from project pickers. Threads and files are kept."
                }
                control={
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isOrganizing}
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
        {/* Links without search keep this project selected through retainSettingsScope. */}
        {/* On touch, the taller lines give each wrapped link a 32px target. */}
        <p className="px-3 text-sm text-pretty text-muted-foreground pointer-coarse:leading-8 sm:px-4">
          More settings for this project:{" "}
          {PROJECT_OVERRIDE_PATHS.map((path, index) => (
            <Fragment key={path}>
              {index === 0 ? null : index === PROJECT_OVERRIDE_PATHS.length - 1 ? " and " : ", "}
              <InlineButton
                tone="link"
                touchTarget="inline"
                ref={(link: HTMLElement | null) => returnToLink(link, path, visit, hash)}
                onClick={(event) => {
                  const link = event.currentTarget;
                  leftByLink = {
                    link,
                    visit,
                    path,
                    scrollTop:
                      link.closest<HTMLElement>("[data-settings-page-scroll]")?.scrollTop ?? 0,
                  };
                }}
                render={
                  <Link
                    to={path}
                    // Voice opens on device settings, so its link lands on the project's part.
                    {...(path === "/settings/voice" ? { hash: "speech-project-dictionary" } : {})}
                  />
                }
              >
                {SETTINGS_SECTION_LABELS[path]}
              </InlineButton>
            </Fragment>
          ))}
          .
        </p>
        <SettingsSection title="Danger">
          <SettingsRow
            id="project-remove"
            title={removeLabel}
            description={
              hasOtherMembers
                ? removeCount === 1
                  ? "Deletes this checkout's entry and its threads. Other checkouts and files on disk are not touched."
                  : `Deletes this machine's ${removeCount} checkout entries and their threads. Other machines and files on disk are not touched.`
                : `${
                    removeCount === 1
                      ? "Deletes the project entry and its threads"
                      : removeCount === 2
                        ? "Deletes both checkout entries and their threads"
                        : `Deletes all ${removeCount} checkout entries and their threads`
                  }${
                    new Set(group.memberProjects.map((member) => member.environmentId)).size > 1
                      ? " on every machine"
                      : ""
                  }. Files on disk are not touched.`
            }
            control={
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={!canEditGroup}
                onClick={() => void removeMembers(group.memberProjects)}
              >
                <Trash2Icon />
                {removeLabel}
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
