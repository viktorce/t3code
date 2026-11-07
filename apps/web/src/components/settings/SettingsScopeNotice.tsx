import { resolveEnvironmentMachineKind, type EnvironmentId } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, LayersIcon } from "lucide-react";
import { useId, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ITEM_ROW_CLASSNAME } from "./itemRows";
import { SettingsGroup } from "./SettingsGroup";
import {
  SettingsPageContainer,
  SettingsSearchTarget,
  SettingsSection,
  useSettingsSearchTarget,
} from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import type { SettingsScopeSearch } from "./settingsScope";
import {
  settingsScopeEnvironmentAddress,
  settingsScopeEnvironmentLabels,
  settingsScopeProjectMachines,
} from "./settingsScopeAxis";

interface ScopeChoice {
  label: string;
  secondary?: string;
  secondaryId?: string;
  icon: ReactNode;
  action?: ReactNode;
  search: SettingsScopeSearch;
}

/** Hash targets that focus a project row, or the list when no row is left, after navigation. */
export const projectRowTargetId = (projectKey: string) => `project:${projectKey}`;
export const PROJECT_LIST_TARGET_ID = "project-list";

function ScopeChoiceRow({ choice, onSelect }: { choice: ScopeChoice; onSelect: () => void }) {
  const targetRef = useSettingsSearchTarget<HTMLButtonElement>(
    choice.search.project && !choice.search.machine
      ? projectRowTargetId(choice.search.project)
      : undefined,
  );
  return (
    <div
      className={cn(
        ITEM_ROW_CLASSNAME,
        "group/scope-choice relative flex min-w-0 items-center gap-3 hover:bg-accent/50",
      )}
    >
      {/* Its ::before covers the row, so a click anywhere outside the action opens the choice. */}
      <button
        ref={targetRef}
        type="button"
        data-project-key={choice.search.project}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-[inherit] text-left outline-none before:absolute before:inset-0 before:rounded-[inherit] focus-visible:before:ring-2 focus-visible:before:ring-inset focus-visible:before:ring-ring"
        onClick={onSelect}
      >
        {choice.icon}
        <span className="relative min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{choice.label}</span>
          {choice.secondary ? (
            <Tooltip>
              <TooltipTrigger
                id={choice.secondaryId}
                render={<span className="flex min-w-0 text-xs text-muted-foreground" />}
              >
                <MiddleTruncate value={choice.secondary} showTitle={false} />
              </TooltipTrigger>
              <TooltipPopup>{choice.secondary}</TooltipPopup>
            </Tooltip>
          ) : null}
        </span>
      </button>
      {choice.action ? (
        <span className="relative flex shrink-0 items-center opacity-0 transition-opacity group-focus-within/scope-choice:opacity-100 group-hover/scope-choice:opacity-100 any-pointer-coarse:opacity-100">
          {choice.action}
        </span>
      ) : null}
      <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </div>
  );
}

export function SettingsScopeNotice({
  children,
  target,
  targetId,
  eligibleEnvironmentIds,
  renderProjectAction,
  inline = false,
}: {
  children: string;
  /** Renders inside a section instead of as its own page. */
  inline?: boolean;
  target: "environment" | "all" | "project" | "checkout";
  targetId?: string;
  eligibleEnvironmentIds?: readonly EnvironmentId[];
  /**
   * Shown at the end of a project row while it is hovered or focused, and always on touch.
   * `descriptionId` is the id of the row's secondary text.
   */
  renderProjectAction?: (group: SidebarProjectSnapshot, descriptionId: string) => ReactNode;
}) {
  const { selectScope, search, groups } = useSettingsScope();
  const idPrefix = useId();
  const navigate = useNavigate({ from: "/settings" });
  const pathname = useLocation({ select: (location) => location.pathname });
  const { environments } = useEnvironments();
  const environmentIcon = (environment: EnvironmentPresentation | undefined) =>
    environment ? (
      <EnvironmentMachineIcon
        aria-hidden
        kind={resolveEnvironmentMachineKind(environment.serverConfig)}
        className="size-4 shrink-0 text-muted-foreground"
      />
    ) : null;
  const choiceGroups =
    target === "checkout"
      ? groups.filter((group) => !search.project || group.projectKey === search.project)
      : [null];
  const renderChoices = (group: SidebarProjectSnapshot | null) => {
    const choices: ScopeChoice[] = group
      ? group.memberProjects.map((member) => {
          const environment = environments.find(
            (entry) => entry.environmentId === member.environmentId,
          );
          const { primary, secondary } = environment
            ? settingsScopeEnvironmentLabels(environment, environments)
            : {
                primary: member.environmentLabel ?? "Environment",
                secondary: member.environmentId,
              };
          return {
            label: primary,
            secondary: [secondary, member.workspaceRoot].filter(Boolean).join(" · "),
            icon: environmentIcon(environment),
            search: {
              project: group.projectKey,
              machine: member.environmentId,
              checkout: member.physicalProjectKey,
            },
          };
        })
      : target === "project"
        ? groups.map((group, index) => {
            const secondaryId = `${idPrefix}-${index}`;
            return {
              label: group.displayName,
              secondary: [
                ...(group.archived ? ["Archived"] : []),
                ...(groups.some(
                  (other) =>
                    other.projectKey !== group.projectKey &&
                    other.displayName === group.displayName,
                )
                  ? settingsScopeProjectMachines(group, environments)
                  : []),
                group.workspaceRoot,
              ].join(" · "),
              secondaryId,
              icon: <ProjectFavicon project={group} className="size-4 shrink-0" />,
              action: renderProjectAction?.(group, secondaryId),
              search: { project: group.projectKey },
            };
          })
        : target === "environment"
          ? environments
              .filter(
                (entry) =>
                  eligibleEnvironmentIds === undefined ||
                  eligibleEnvironmentIds.includes(entry.environmentId),
              )
              .map((entry) => {
                const { primary, secondary } = settingsScopeEnvironmentLabels(entry, environments);
                return {
                  label: primary,
                  secondary: secondary || settingsScopeEnvironmentAddress(entry),
                  icon: environmentIcon(entry),
                  search: { machine: entry.environmentId },
                };
              })
          : [
              {
                label: "Open all environments",
                icon: <LayersIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />,
                search: {},
              },
            ];
    return choices.map((choice) => (
      <ScopeChoiceRow
        key={JSON.stringify(choice.search)}
        choice={choice}
        onSelect={() => {
          if (targetId)
            void navigate({
              to: pathname,
              search: () => ({
                project: undefined,
                machine: undefined,
                checkout: undefined,
                ...choice.search,
              }),
              hash: targetId,
            });
          else selectScope(choice.search);
        }}
      />
    ));
  };
  const notice = (
    <div className="space-y-3">
      <SettingsSearchTarget id={target === "project" ? PROJECT_LIST_TARGET_ID : undefined}>
        <p role="status" className="px-3 text-sm text-muted-foreground sm:px-4">
          {children}
        </p>
      </SettingsSearchTarget>
      <div className="space-y-4">
        {choiceGroups.map((group) =>
          group?.displayName ? (
            <SettingsSection key={group.projectKey} title={group.displayName}>
              {renderChoices(group)}
            </SettingsSection>
          ) : (
            <SettingsGroup key={group?.projectKey ?? target}>{renderChoices(group)}</SettingsGroup>
          ),
        )}
      </div>
    </div>
  );
  return inline ? notice : <SettingsPageContainer>{notice}</SettingsPageContainer>;
}
