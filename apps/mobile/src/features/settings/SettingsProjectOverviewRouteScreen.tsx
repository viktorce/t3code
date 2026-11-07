import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import * as Dialog from "../../components/ui/Dialog";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import {
  describeProjectRemovalFailure,
  isProjectNotFoundError,
  isProjectRemovalUnsent,
  planProjectRemoval,
  projectChangeWait,
  projectRemovalFailureText,
  projectRemovalGrowth,
  projectRemovalReadiness,
  projectRemovalReconfirmation,
  projectRemovalRefusal,
  projectRemovalTarget,
  projectRemovalWait,
} from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  deriveProjectGroupLabel,
  type ProjectGroup,
} from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { readEnvironment, useEnvironments } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { liveShellEnvironmentIdsAtom } from "../../state/shell";
import { readThreadShells } from "../../state/entities";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  clearComposerDraft,
  composerDraftsAtom,
  findNewTaskDraftKeys,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import {
  readEnvironmentScopeState,
  useEnvironmentScope,
  useEnvironmentScopeStates,
} from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import { leaveSettingsPage } from "./settings-navigation";
import { workspaceHasColumns } from "../layout/workspace/workspace-selection-store";
import { DEFAULT_SETTINGS_PAGE } from "../layout/workspace/workspace-tab-navigation";
import { readUnloadedThreadCount } from "../../state/olderSettledShelf";

export function SettingsProjectOverviewRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const insets = useSafeAreaInsets();
  const [isRemoving, setIsRemoving] = useState(false);
  const removalPending = useRef(false);
  const startRemoval = () => {
    if (removalPending.current) return false;
    removalPending.current = true;
    return true;
  };
  const finishRemoval = () => {
    removalPending.current = false;
    setIsRemoving(false);
  };
  const navigation = useNavigation();
  const {
    availableTargets,
    projectMembersOf,
    projectGroups,
    selectedProjectKey,
    selectProject,
    getSelectedProjectKey,
  } = useSettingsEnvironmentFilter();
  // The filter can move to another project while a removal is still running.
  const finishProjectRemoval = (projectKey: string | null) => {
    if (getSelectedProjectKey() !== projectKey) return;
    if (navigation.isFocused())
      leaveSettingsPage(navigation, workspaceHasColumns(), DEFAULT_SETTINGS_PAGE);
    // Otherwise the filter keeps pointing at the removed project as an unavailable one.
    selectProject(null);
  };
  const group = projectGroups.find((entry) => entry.key === selectedProjectKey);
  // Checkouts on machines that aren't connected stay, so the page says why they can't change, and
  // removing the project everywhere never quietly skips them.
  const members = group ? projectMembersOf(group) : [];

  return (
    <SettingsScreen title="Projects" menus={[environmentMenu]}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedProjectKey === null ? (
          <Text className="px-2 text-base text-foreground-muted">
            Choose a project with the filter above to manage its name, checkouts and removal.
          </Text>
        ) : !group || members.length === 0 ? (
          <Text className="px-2 text-base text-foreground-muted">
            This project has no checkout on the selected environments. Change the filter above.
          </Text>
        ) : (
          <ProjectOverviewContent
            key={`${selectedProjectKey}:${members.map((member) => member.id).join(",")}`}
            members={members}
            group={group}
            connectedTargets={availableTargets}
            hasOtherMembers={members.length < (group?.members.length ?? 0)}
            isRemoving={isRemoving}
            setIsRemoving={setIsRemoving}
            startRemoval={startRemoval}
            finishRemoval={finishRemoval}
            projectKey={selectedProjectKey}
            onProjectRemoved={finishProjectRemoval}
          />
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function ProjectOverviewContent(props: {
  readonly members: readonly EnvironmentProject[];
  /** Pin and archive belong to the whole project, even when the filter picks one machine. */
  readonly group: ProjectGroup;
  readonly connectedTargets: readonly SettingsTarget[];
  readonly hasOtherMembers: boolean;
  readonly isRemoving: boolean;
  readonly setIsRemoving: (isRemoving: boolean) => void;
  readonly startRemoval: () => boolean;
  readonly finishRemoval: () => void;
  readonly projectKey: string | null;
  readonly onProjectRemoved: (projectKey: string | null) => void;
}) {
  const { isRemoving, setIsRemoving, startRemoval, finishRemoval } = props;
  const { environments } = useEnvironments();
  // A grant outlives its connection, so an offline machine's checkouts still look removable.
  const isOffline = (member: EnvironmentProject) =>
    !props.connectedTargets.some((target) => target.environmentId === member.environmentId);
  const connectedMembers = props.members.filter((member) => !isOffline(member));
  // An offline machine can't show its project's icon.
  const representative = connectedMembers[0] ?? props.members[0]!;
  const displayName = deriveProjectGroupLabel({ representative, members: props.members });
  const [draftName, setDraftName] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const allMembers = props.group.members.map((member) => member.project);
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const updateProject = useAtomCommand(projectEnvironment.update, {
    label: "project name update",
    reportFailure: true,
  });
  const organizeProject = useAtomCommand(projectEnvironment.update, {
    label: "project update",
    reportFailure: true,
  });
  const [isOrganizing, setIsOrganizing] = useState(false);
  const memberTargets = allMembers.map((member) =>
    props.connectedTargets.find((entry) => entry.environmentId === member.environmentId),
  );
  // Older servers drop pin and archive, so their projects do not offer them. Otherwise the rows
  // wait while a machine refuses, is offline, or is loading, and say why.
  const canOrganize = memberTargets.every(
    (target) =>
      target === undefined ||
      target.serverConfig.environment.capabilities.projectOrganization === true,
  );
  // One machine at a time, stopping at the first failure, as web does.
  const labelOfEnvironment = (environmentId: EnvironmentProject["environmentId"]) =>
    environments.find((entry) => entry.environmentId === environmentId)?.label ??
    "this environment";
  const organize = async (input: { readonly pinned?: boolean; readonly archived?: boolean }) => {
    setIsOrganizing(true);
    for (const member of allMembers) {
      // A machine can drop, lose its grant, or fail a session check between writes, as on web.
      const readiness = projectRemovalReadiness(
        readEnvironment(member.environmentId),
        readEnvironmentScopeState(member.environmentId, AuthOrchestrationOperateScope),
        true,
      );
      if (readiness !== "ready") {
        const refusal = projectRemovalRefusal(
          "Failed to update project",
          readiness,
          labelOfEnvironment(member.environmentId),
        );
        Dialog.alert(refusal.title, projectRemovalFailureText(refusal));
        break;
      }
      const result = await organizeProject({
        environmentId: member.environmentId,
        input: { projectId: member.id, ...input },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Dialog.alert(
            `Failed to update "${member.title}"`,
            error instanceof Error ? error.message : "An error occurred.",
          );
        }
        break;
      }
    }
    setIsOrganizing(false);
  };
  // The confirmation counts a machine's threads, so removal waits for them as well as its settings.
  const liveEnvironmentIds = useAtomValue(liveShellEnvironmentIdsAtom);
  // A machine that hasn't connected since the app started has no session to grant or refuse yet.
  const scopeStates = useEnvironmentScopeStates(allMembers, AuthOrchestrationOperateScope);

  const nextName = (draftName ?? displayName).trim();
  // A shared edit writes to every checkout, so it waits for all of them, in the removal rows' order.
  // It counts no threads, so it doesn't wait for them. Renaming only some would split the name.
  const changeWait = (members: readonly EnvironmentProject[]) =>
    projectChangeWait(
      members,
      (member) =>
        projectRemovalReadiness(
          environments.find((entry) => entry.environmentId === member.environmentId),
          scopeStates.get(member.environmentId) ?? "unknown",
          true,
        ),
      (member) => labelOfEnvironment(member.environmentId),
    );
  const renameWait = changeWait(props.members);
  const organizeWait = changeWait(allMembers);
  const canSave =
    !isSaving && renameWait === null && nextName.length > 0 && nextName !== displayName;
  const readinessOf = (member: EnvironmentProject) =>
    projectRemovalReadiness(
      environments.find((entry) => entry.environmentId === member.environmentId),
      scopeStates.get(member.environmentId) ?? "unknown",
      liveEnvironmentIds.has(member.environmentId),
    );
  const removalWait = (members: readonly EnvironmentProject[]) =>
    projectRemovalWait(members, readinessOf, (member) => labelOfEnvironment(member.environmentId));
  const removeAllWait = removalWait(props.members);

  // Refuses before the confirm, and again after it, reading the machines as of that moment: while
  // the confirm waits, one can drop, lose its grant, or start reloading the threads it counted.
  const checkRemovalAccess = (members: readonly EnvironmentProject[]) => {
    const live = appAtomRegistry.get(liveShellEnvironmentIdsAtom);
    for (const member of members) {
      const readiness = projectRemovalReadiness(
        readEnvironment(member.environmentId),
        readEnvironmentScopeState(member.environmentId, AuthOrchestrationOperateScope),
        live.has(member.environmentId),
      );
      if (readiness === "ready") continue;
      const refusal = projectRemovalRefusal(
        "Failed to remove project",
        readiness,
        labelOfEnvironment(member.environmentId),
      );
      Dialog.alert(refusal.title, projectRemovalFailureText(refusal));
      return false;
    }
    return true;
  };

  // Planned from the threads as they are now: a confirmation can wait while threads start or appear.
  const planRemoval = (members: readonly EnvironmentProject[]) => {
    const threads = readThreadShells();
    return planProjectRemoval({
      members: members.map((member) => ({
        ...member,
        environmentLabel: environments.find((entry) => entry.environmentId === member.environmentId)
          ?.label,
      })),
      groupMemberCount: props.members.length,
      hasOtherMembers: props.hasOtherMembers,
      displayName,
      threads,
      unloadedThreadCount: readUnloadedThreadCount(members, threads),
    });
  };

  const removeMembers = (members: readonly EnvironmentProject[]) => {
    if (!checkRemovalAccess(members) || !startRemoval()) return;
    confirmRemoval(members, planRemoval(members), null);
  };

  const confirmRemoval = (
    members: readonly EnvironmentProject[],
    asked: ReturnType<typeof planRemoval>,
    growth: string | null,
  ) => {
    const projectKey = props.projectKey;
    const confirmLabel =
      asked.targetKind === "project"
        ? "Remove project"
        : members.length === 1
          ? "Remove checkout"
          : `Remove ${members.length} checkouts`;
    Dialog.confirm({
      title: confirmLabel,
      message:
        growth === null ? asked.confirmationMessage : projectRemovalReconfirmation(asked, growth),
      confirmText: confirmLabel,
      destructive: true,
      onCancel: finishRemoval,
      onConfirm: () => {
        // A machine that dropped or started reloading meanwhile refuses before any second question.
        if (!checkRemovalAccess(members)) {
          finishRemoval();
          return;
        }
        const plan = planRemoval(members);
        // A thread to delete or stop that the answer didn't cover needs its own answer.
        const grown = projectRemovalGrowth(asked, plan);
        if (grown !== null) {
          confirmRemoval(members, plan, grown);
          return;
        }
        void (async () => {
          setIsRemoving(true);
          let removedCount = 0;
          const labelOf = (member: EnvironmentProject) => labelOfEnvironment(member.environmentId);
          // Every failure after the first removal says what is already gone, before what to do.
          const fail = (
            member: EnvironmentProject,
            kind: "denied" | "loading" | "unsent" | "interrupted" | "rejected",
            error?: unknown,
          ) => {
            const failure = describeProjectRemovalFailure({
              kind,
              target: projectRemovalTarget(member, members, labelOf),
              machine: labelOf(member),
              removedCount,
              error,
              listInView: true,
            });
            Dialog.alert(failure.title, projectRemovalFailureText(failure));
          };
          for (const member of members) {
            // Read again for each checkout: while earlier ones go, a machine can drop, lose its
            // grant, or fail a session check. The confirmation already counted the threads.
            const readiness = projectRemovalReadiness(
              readEnvironment(member.environmentId),
              readEnvironmentScopeState(member.environmentId, AuthOrchestrationOperateScope),
              true,
            );
            if (readiness !== "ready") {
              fail(member, readiness === "offline" ? "unsent" : readiness);
              return;
            }
            const result = await deleteProject({
              environmentId: member.environmentId,
              input: { projectId: member.id, force: true },
            });
            if (result._tag === "Failure") {
              // A dropped connection interrupts the command, and the server may or may not have applied it.
              if (isAtomCommandInterrupted(result)) {
                fail(member, "interrupted");
                return;
              }
              const error = squashAtomCommandFailure(result);
              // Another client, or an earlier attempt, may have removed it already; that is the goal.
              if (!isProjectNotFoundError(error)) {
                // A machine that dropped after an earlier checkout went never received this one.
                if (isProjectRemovalUnsent(error)) fail(member, "unsent");
                else fail(member, "rejected", error);
                return;
              }
            }
            removedCount += 1;
            await waitForComposerDraftsLoaded()
              .then(() => {
                for (const draftKey of findNewTaskDraftKeys(
                  appAtomRegistry.get(composerDraftsAtom),
                  {
                    environmentId: member.environmentId,
                    projectId: member.id,
                  },
                )) {
                  clearComposerDraft(draftKey);
                }
              })
              .catch((error) => {
                console.warn("[project-removal] could not clear composer drafts", error);
              });
          }
          // Nothing is left to show once the whole project is gone.
          if (plan.targetKind === "project") props.onProjectRemoved(projectKey);
        })().finally(finishRemoval);
      },
    });
  };

  const saveName = () => {
    if (!canSave) return;
    setIsSaving(true);
    void (async () => {
      const results = await Promise.all(
        props.members.map((member) =>
          updateProject({
            environmentId: member.environmentId,
            input: { projectId: member.id, title: nextName },
          }),
        ),
      );
      setIsSaving(false);
      if (results.every((result) => result._tag !== "Failure")) setDraftName(null);
    })();
  };

  return (
    <>
      <View className="flex-row items-center gap-4 px-2">
        <ProjectFavicon
          environmentId={representative.environmentId}
          projectTitle={representative.title}
          workspaceRoot={representative.workspaceRoot}
          faviconPath={representative.faviconPath}
          projectIcon={representative.projectIcon}
          size={48}
        />
        <View className="min-w-0 flex-1">
          <Text className="text-xl font-t3-semibold text-foreground" numberOfLines={2}>
            {displayName}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {props.members.length === 1 ? "1 checkout" : `${props.members.length} checkouts`}
          </Text>
        </View>
      </View>

      <SettingsSection title="Project">
        <View className="gap-3 p-4">
          <Text className="text-sm font-t3-medium text-foreground-muted">Name</Text>
          <View className="flex-row items-center gap-3">
            <AppTextInput
              accessibilityLabel="Project name"
              className="min-h-11 min-w-0 flex-1 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
              value={draftName ?? displayName}
              onChangeText={setDraftName}
              onSubmitEditing={saveName}
              returnKeyType="done"
              editable={!isSaving && renameWait === null}
            />
            {/* A draft the wait interrupted stays, with Save shown waiting, so it doesn't read as saved. */}
            {nextName.length > 0 && nextName !== displayName ? (
              <Button
                label="Save"
                accessibilityHint="Save project name"
                tone="secondary"
                disabled={!canSave}
                onPress={saveName}
              />
            ) : null}
          </View>
          {renameWait ? (
            <Text className="text-sm leading-normal text-foreground-muted">{renameWait}</Text>
          ) : null}
        </View>
      </SettingsSection>

      {canOrganize ? (
        <SettingsSection title="Organize">
          <SettingsSwitchRow
            icon="pin"
            label="Pin"
            subtitle={[
              "Pinned projects come first in project pickers.",
              // With some machines filtered out, a reason can name one of them.
              ...(props.hasOtherMembers ? ["This applies to every checkout."] : []),
              ...(organizeWait ? [organizeWait] : []),
            ].join(" ")}
            value={props.group.pinned}
            disabled={isOrganizing || organizeWait !== null}
            onValueChange={(pinned) => void organize({ pinned })}
          />
          <SettingsActionRow
            icon="archivebox"
            label={props.group.archived ? "Unarchive project" : "Archive project"}
            description={[
              props.group.archived
                ? "Hidden from project pickers. Threads and files are kept."
                : "Hides the project from project pickers. Threads and files are kept.",
              ...(props.hasOtherMembers ? ["This applies to every checkout."] : []),
              ...(organizeWait ? [organizeWait] : []),
            ].join(" ")}
            disabled={isOrganizing || organizeWait !== null}
            onPress={() => void organize({ archived: !props.group.archived })}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection title="Checkouts">
        {props.members.map((member, index) => {
          const environment = environments.find(
            (entry) => entry.environmentId === member.environmentId,
          );
          const wait = removalWait([member]);
          return (
            <View
              key={`${member.environmentId}:${member.id}`}
              className={index === 0 ? "gap-1 p-4" : "gap-1 border-t border-border-subtle p-4"}
            >
              <Text
                className={
                  Platform.OS === "android"
                    ? "text-base text-foreground"
                    : "text-lg text-foreground"
                }
              >
                {environment?.label ?? "Environment"}
              </Text>
              {environment?.displayUrl ? (
                <Text className="text-sm leading-normal text-foreground-muted">
                  {environment.displayUrl}
                </Text>
              ) : null}
              <Text className="text-sm leading-normal text-foreground-muted" selectable>
                {member.workspaceRoot}
              </Text>
              {props.members.length > 1 || props.hasOtherMembers ? (
                <>
                  {wait ? (
                    <Text className="text-sm leading-normal text-foreground-muted">{wait}</Text>
                  ) : null}
                  <RemoveCheckoutAction
                    member={member}
                    disabled={isRemoving || wait !== null}
                    onPress={() => removeMembers([member])}
                  />
                </>
              ) : null}
            </View>
          );
        })}
      </SettingsSection>
      <SettingsSection title="Danger">
        <SettingsActionRow
          icon="trash"
          label={
            props.hasOtherMembers
              ? props.members.length === 1
                ? "Remove checkout"
                : `Remove ${props.members.length} checkouts`
              : props.members.length > 1
                ? "Remove this project everywhere"
                : "Remove project"
          }
          description={[
            props.hasOtherMembers
              ? `Deletes the selected checkout ${props.members.length === 1 ? "entry and its threads. Its folder stays" : "entries and their threads. Their folders stay"} on disk, and the project keeps its other checkouts.`
              : props.members.length > 1
                ? `Deletes ${props.members.length === 2 ? "both" : `all ${props.members.length}`} checkout entries and their threads on every machine. Their folders stay on disk.`
                : "Deletes the project entry and its threads. The project folder stays on disk.",
            // Why it waits follows what it does, as on web.
            ...(removeAllWait ? [removeAllWait] : []),
          ].join(" ")}
          tone="danger"
          disabled={isRemoving || removeAllWait !== null}
          loading={isRemoving}
          onPress={() => removeMembers(props.members)}
        />
      </SettingsSection>
    </>
  );
}

function RemoveCheckoutAction(props: {
  readonly member: EnvironmentProject;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const canRemove = useEnvironmentScope(props.member.environmentId, AuthOrchestrationOperateScope);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Remove checkout ${props.member.workspaceRoot}`}
      disabled={props.disabled || !canRemove}
      onPress={props.onPress}
      className="self-start rounded-full border border-border bg-card px-3 py-1.5 disabled:opacity-40"
    >
      <Text className="font-t3-medium text-xs text-danger-foreground">Remove checkout</Text>
    </Pressable>
  );
}
