import { resolveEnvironmentMachineKind, type EnvironmentId } from "@t3tools/contracts";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, LayersIcon, ServerIcon } from "lucide-react";
import { useId, useRef, type ComponentProps, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useAllEnvironmentShellsBootstrapped } from "../../state/entities";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useUnloadedShellEnvironmentIds } from "../../state/shell";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button, InlineButton } from "../ui/button";
import { ITEM_ROW_CLASSNAME } from "./itemRows";
import { PathText } from "./PathText";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import type { SettingsScopeSearch } from "./settingsScope";
import {
  projectScopeMenuGroups,
  SCRATCH_PROJECT_DESCRIPTION,
  selectProjectAxis,
  settingsScopeEnvironmentAddress,
  settingsScopeEnvironmentLabels,
  settingsScopeEnvironmentNames,
  settingsScopeProjectDistinction,
  settingsScopeProjectPath,
  settingsScopeReconnectMessage,
} from "./settingsScopeAxis";

export function OpenEnvironmentsButton(props: ComponentProps<typeof Button>) {
  return (
    <Button variant="outline" size="sm" render={<Link to="/settings/connections" />} {...props}>
      <ServerIcon />
      Open Environments
    </Button>
  );
}

/** Drops a search result that waits for another scope; the scope stays as it is. */
export function CancelSearchButton(props: ComponentProps<typeof InlineButton>) {
  const navigate = useNavigate({ from: "/settings" });
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <InlineButton
      {...props}
      tone="link"
      touchTarget="inline"
      // It follows a sentence's period, so its focus ring keeps the room before it.
      className="ms-0"
      onClick={() => void navigate({ to: pathname, hash: "", replace: true })}
    >
      Cancel
    </InlineButton>
  );
}

// A row's icon sits on its name's line, not beside the middle of a wrapped path.
const CHOICE_ICON_CLASSNAME = "mt-0.5 size-4 shrink-0 self-start";

interface ScopeChoice {
  label: string;
  secondary?: string;
  /** Another choice shares the label, so the secondary line is part of the row's name. */
  sharesLabel?: boolean;
  icon: ReactNode;
  search: SettingsScopeSearch;
}

// Every scope change remounts the list, so the way back restores where a row click left it.
let listScrollTop: number | undefined;

// The navigation whose search result last took focus. Projects that load later swap an empty
// list's note for the list without navigating, and must not take focus from the user again.
let focusedSearchVisit: string | undefined;
/** Whether a search result opened by this navigation may still take focus; claims it if so. */
export function claimSearchFocus(visit: string | undefined): boolean {
  if (visit !== undefined && visit === focusedSearchVisit) return false;
  focusedSearchVisit = visit;
  return true;
}

// Scrolls only the settings page: scrollIntoView would also move clipped modal containers.
function revealChoice(row: HTMLElement | null) {
  const scroller = row?.closest<HTMLElement>("[data-settings-page-scroll]");
  if (!row || !scroller) return;
  if (listScrollTop !== undefined) scroller.scrollTop = listScrollTop;
  listScrollTop = undefined;
  const box = scroller.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  // Centered like a settings search target, so a row coming from above clears the page's top fade.
  if (rect.top < box.top || rect.bottom > box.bottom)
    scroller.scrollTop += rect.top + rect.height / 2 - (box.top + box.height / 2);
}

// Search results take focus, so one that first needs a project focuses the list instead.
function focusChoice(row: HTMLElement | null) {
  if (!row) return;
  listScrollTop = undefined;
  row.focus({ preventScroll: true });
  revealChoice(row);
}

export function SettingsScopeNotice({
  children,
  target,
  targetId,
  eligibleEnvironmentIds,
  inline = false,
}: {
  children: string;
  /** Renders inside a section instead of as its own page. */
  inline?: boolean;
  target: "environment" | "all" | "project" | "checkout";
  targetId?: string;
  eligibleEnvironmentIds?: readonly EnvironmentId[];
}) {
  const { selectScope, search, groups, lastProject, returnedFromProject } = useSettingsScope();
  // A removed project's page hands its place on the list to the row that was next to it.
  const removedNeighbor = useLocation({
    select: (location) => location.state.settingsFocusProject,
  });
  const visit = useLocation({ select: (location) => location.state.__TSR_key });
  const navigate = useNavigate({ from: "/settings" });
  const rowId = useId();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { environments } = useEnvironments();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const unloadedIds = useUnloadedShellEnvironmentIds();
  // A list of every environment's projects says whose are missing; a filtered list shows only one.
  const unloaded =
    target === "project" && !search.machine
      ? environments.filter((entry) => unloadedIds.has(entry.environmentId))
      : [];
  const unloadedNote =
    unloaded.length === 0
      ? ""
      : bootstrapped
        ? settingsScopeReconnectMessage(unloaded, environments)
        : `Loading projects from ${settingsScopeEnvironmentNames(unloaded, environments)}…`;
  // With no environment to choose, the way on is connecting or updating one.
  const noEnvironment =
    target === "environment" &&
    !environments.some(
      (entry) =>
        eligibleEnvironmentIds === undefined ||
        eligibleEnvironmentIds.includes(entry.environmentId),
    );
  // Rows re-sort as environments load, so only the first row to take the mark gets placed.
  const placed = useRef(false);
  const place = (row: HTMLElement | null) => {
    if (!row || placed.current) return;
    placed.current = true;
    if (returnedFromProject) revealChoice(row);
    else if (claimSearchFocus(visit)) focusChoice(row);
  };
  const environmentIcon = (environment: EnvironmentPresentation | undefined) =>
    environment ? (
      <EnvironmentMachineIcon
        aria-hidden
        kind={resolveEnvironmentMachineKind(environment.serverConfig)}
        className={cn(CHOICE_ICON_CLASSNAME, "text-muted-foreground")}
      />
    ) : null;
  const choiceGroups =
    target === "checkout"
      ? groups.filter((group) => !search.project || group.projectKey === search.project)
      : [null];
  const renderChoices = (group: SidebarProjectSnapshot | null, groupIndex: number) => {
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
        ? projectScopeMenuGroups(groups, search).map((group) => {
            const path = settingsScopeProjectPath(group, search.machine);
            const distinction = settingsScopeProjectDistinction(
              group,
              groups,
              environments,
              search.machine,
            );
            return {
              label: group.displayName,
              sharesLabel: distinction !== null,
              secondary: group.isScratch
                ? SCRATCH_PROJECT_DESCRIPTION
                : [
                    ...(group.pinned ? ["Pinned"] : []),
                    ...(group.archived ? ["Archived"] : []),
                    // The path is always shown; differing environments go before it.
                    ...(distinction && distinction !== path ? [distinction] : []),
                    path,
                  ].join(" · "),
              icon: <ProjectFavicon project={group} className={CHOICE_ICON_CLASSNAME} />,
              search: selectProjectAxis(search, group.projectKey),
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
                // Named for the scope it opens, as the scope line names it.
                label: !search.project
                  ? "All environments"
                  : search.machine && environments.length > 1
                    ? "All projects and environments"
                    : "All projects",
                icon: (
                  <LayersIcon
                    aria-hidden
                    className={cn(CHOICE_ICON_CLASSNAME, "text-muted-foreground")}
                  />
                ),
                search: {},
              },
            ];
    // Focus recovery and F6 land on the project just left, else the first project. A fresh
    // search result starts at the first choice of any list, so its message stays in view.
    const focusProject =
      target === "project"
        ? (targetId && !returnedFromProject
            ? choices[0]
            : (choices.find(
                (choice) => choice.search.project === (removedNeighbor ?? lastProject),
              ) ?? choices[0])
          )?.search.project
        : undefined;
    return choices.map((choice, index) => {
      const focusRow =
        target === "project"
          ? focusProject !== undefined && choice.search.project === focusProject
          : Boolean(targetId) && groupIndex === 0 && index === 0;
      return (
        <button
          key={JSON.stringify(choice.search)}
          // Name the row by its label; the path is a description, not part of every announcement,
          // unless the path is what tells the row from another with the same label.
          aria-labelledby={
            choice.sharesLabel
              ? `${rowId}-${groupIndex}-${index} ${rowId}-${groupIndex}-${index}-detail`
              : `${rowId}-${groupIndex}-${index}`
          }
          // A search result focuses this row, so the row also carries the message naming its setting.
          aria-describedby={
            [
              ...(focusRow && targetId ? [`${rowId}-message`] : []),
              ...(choice.secondary && !choice.sharesLabel
                ? [`${rowId}-${groupIndex}-${index}-detail`]
                : []),
            ].join(" ") || undefined
          }
          {...(focusRow
            ? {
                "data-workspace-focus-default": "",
                ...(returnedFromProject || targetId ? { ref: place } : {}),
              }
            : {})}
          type="button"
          className={cn(
            ITEM_ROW_CLASSNAME,
            "flex w-full min-w-0 cursor-pointer items-center gap-3 text-left hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          )}
          onClick={(event) => {
            if (target === "project") {
              listScrollTop = event.currentTarget.closest<HTMLElement>(
                "[data-settings-page-scroll]",
              )?.scrollTop;
            }
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
        >
          {choice.icon}
          <span className="min-w-0 flex-1">
            <span
              id={`${rowId}-${groupIndex}-${index}`}
              className="block text-sm font-medium wrap-anywhere"
            >
              {choice.label}
            </span>
            {choice.secondary ? (
              <span
                id={`${rowId}-${groupIndex}-${index}-detail`}
                className="block text-xs text-muted-foreground wrap-anywhere"
              >
                <PathText text={choice.secondary} />
              </span>
            ) : null}
          </span>
          <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </button>
      );
    });
  };
  const notice = (
    <div className="space-y-3">
      <p
        // No live region for a search result: its message describes the row it focuses.
        role={target === "project" || targetId ? undefined : "status"}
        // A search result's message is what changed, so it reads stronger than an intro. On
        // touch, its taller line gives Cancel a 32px target.
        className={cn(
          "px-3 text-sm sm:px-4",
          targetId ? "text-foreground pointer-coarse:leading-8" : "text-muted-foreground",
        )}
      >
        <span id={`${rowId}-message`}>
          {children}
          {/* Loading and reconnect news arrives while focus stays in the list, so it is live. */}
          {target === "project" ? (
            <span role="status">{unloadedNote ? ` ${unloadedNote}` : ""}</span>
          ) : null}
        </span>
        {targetId ? (
          <>
            {" "}
            <CancelSearchButton aria-describedby={`${rowId}-message`} />
          </>
        ) : null}
      </p>
      {bootstrapped && unloaded.length > 0 ? (
        <div className="px-3 sm:px-4">
          <OpenEnvironmentsButton aria-describedby={`${rowId}-message`} />
        </div>
      ) : null}
      {noEnvironment ? (
        <div className="px-3 sm:px-4">
          <OpenEnvironmentsButton
            data-workspace-focus-default
            aria-describedby={`${rowId}-message`}
            {...(targetId ? { ref: place } : {})}
          />
        </div>
      ) : null}
      <div className="space-y-4">
        {choiceGroups.map((group, groupIndex) => {
          const rows = renderChoices(group, groupIndex);
          if (rows.length === 0) return null;
          return group?.displayName ? (
            <SettingsSection key={group.projectKey} title={group.displayName}>
              {rows}
            </SettingsSection>
          ) : (
            <SettingsGroup
              key={group?.projectKey ?? target}
              {...(target === "project" ? { role: "group", "aria-label": "Projects" } : {})}
            >
              {rows}
            </SettingsGroup>
          );
        })}
      </div>
    </div>
  );
  return inline ? (
    notice
  ) : (
    // The project list matches a project page's spacing, so content starts at the same height.
    <SettingsPageContainer className={target === "project" ? "gap-6" : ""}>
      {notice}
    </SettingsPageContainer>
  );
}
