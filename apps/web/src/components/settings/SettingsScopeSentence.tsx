import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, LayersIcon } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";

import { requestWorkspaceFocus } from "../../lib/workspaceFocus";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useAllEnvironmentShellsBootstrapped } from "../../state/entities";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { PathText } from "./PathText";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import { getSettingsSearchTargetScope, SETTINGS_SECTION_LABELS } from "./settingsSearch";
import {
  ALL_ENVIRONMENTS_VALUE,
  ALL_PROJECTS_VALUE,
  SCRATCH_PROJECT_DESCRIPTION,
  environmentAxisValue,
  projectAxisValue,
  projectScopeMenuGroups,
  selectEnvironmentAxis,
  selectProjectAxis,
  settingsScopeEnvironmentAddress,
  settingsScopeEnvironmentLabel,
  settingsScopeEnvironmentLabels,
  settingsScopeProjectDistinction,
  settingsScopeProjectPath,
} from "./settingsScopeAxis";

export const SETTINGS_DEVICE_ONLY_PATHS: ReadonlySet<string> = new Set([
  "/settings/general",
  "/settings/appearance",
  "/settings/chat",
  "/settings/diffs",
  "/settings/snap-shot",
  "/settings/connections",
  // Access picks its environment on the page itself.
  "/settings/access",
  "/settings/about",
]);

const SECTION_LABELS: Readonly<Record<string, string>> = SETTINGS_SECTION_LABELS;

interface SettingsScopeMenuProps {
  readonly value: SettingsScopeSearch;
  readonly groups: readonly SidebarProjectSnapshot[];
  readonly environments: readonly EnvironmentPresentation[];
  readonly singleEnvironment: boolean;
  readonly onChange: (next: SettingsScopeSearch) => void;
}

export function SettingsScopeSentence() {
  const scope = useOptionalSettingsScope();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { environments } = useEnvironments();
  if (scope === null || SETTINGS_DEVICE_ONLY_PATHS.has(pathname)) return null;
  // One environment leaves nothing to choose, unless a filter on it needs a way to be cleared.
  const onlyEnvironmentId = environments.length === 1 ? environments[0]!.environmentId : null;
  const showEnvironment =
    onlyEnvironmentId === null ||
    scope.search.checkout !== undefined ||
    (scope.search.machine !== undefined && scope.search.machine !== onlyEnvironmentId);
  // Nor does a missing project's page, which offers its own way back to the list.
  if (
    !showEnvironment &&
    pathname === "/settings/projects" &&
    scope.scope.kind === "unavailable" &&
    scope.scope.reason === "project-missing"
  )
    return null;
  const props: SettingsScopeMenuProps = {
    value: scope.search,
    singleEnvironment: scope.singleEnvironment,
    groups: scope.groups,
    environments,
    onChange: scope.selectScope,
  };
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-3 text-sm text-muted-foreground sm:px-4">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0">
          {/* The project list applies nothing; it only shows which projects it lists. */}
          {pathname === "/settings/projects" && !scope.search.project ? "Showing" : "Settings for"}
        </span>
        {/* The Projects page has its own focus targets: the list row and the project's card. */}
        <ProjectScopeMenu
          {...props}
          focusDefault={pathname !== "/settings/projects"}
          listing={pathname === "/settings/projects" && !scope.search.project}
          pageLabel={SECTION_LABELS[pathname]}
        />
      </span>
      {showEnvironment ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">
            {scope.search.machine || scope.scope.kind === "checkout" ? "on" : "across"}
          </span>
          <EnvironmentScopeMenu {...props} />
        </span>
      ) : null}
    </p>
  );
}

interface ScopeOption {
  value: string;
  label: string;
  secondary?: string;
  icon?: ReactNode;
  offline?: boolean;
}

function ScopeOptionLabel({ option }: { option: ScopeOption }) {
  return (
    <>
      {/* Centers the icon on the label's line when the details below it wrap. */}
      {option.icon ? <span className="mt-0.75 flex shrink-0 self-start">{option.icon}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{option.label}</span>
        {/* Wraps instead of truncating: the end of a path is what tells same-name projects apart. */}
        {option.secondary ? (
          <span className="block text-xs wrap-anywhere text-muted-foreground">
            <PathText text={option.secondary} />
          </span>
        ) : null}
      </span>
      {option.offline ? (
        <span className="shrink-0 text-xs text-muted-foreground">Offline</span>
      ) : null}
    </>
  );
}

function ScopeMenu({
  id,
  focusDefault = false,
  ariaLabel,
  icon,
  label,
  value,
  options,
  allOption,
  searchLabel,
  onChange,
}: {
  /** Stable across scope changes, so focus can return to the remounted trigger. */
  id: string;
  focusDefault?: boolean;
  ariaLabel: string;
  icon: ReactNode;
  label: string;
  value: string;
  options: ScopeOption[];
  allOption: ScopeOption | null;
  searchLabel: string;
  onChange: (next: string) => void;
}) {
  const [query, setQuery] = useState("");
  const searchPending = useLocation({
    select: (location) => getSettingsSearchTargetScope(location.hash) !== null,
  });
  // A new scope remounts the page, trigger included, so focus waits for the new trigger.
  // A pending search result keeps its hash and takes focus itself once the scope shows it.
  const select = (next: string) => {
    onChange(next);
    if (!searchPending) requestWorkspaceFocus({ area: "settings", selector: `#${id}` });
  };
  const Trigger = options.length > 6 ? ComboboxTrigger : MenuTrigger;
  const trigger = (
    <Trigger
      id={id}
      {...(focusDefault ? { "data-workspace-focus-default": "" } : {})}
      // Voice control users say what they see, so the name starts with the visible label.
      aria-label={`${label}, ${ariaLabel}`}
      render={<Button variant="outline" size="sm" />}
      className="min-w-0 max-w-72 shrink"
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDownIcon
        aria-hidden
        strokeWidth={1.75}
        className="-me-0.5 size-3.5 shrink-0 text-muted-foreground opacity-70"
      />
    </Trigger>
  );
  const choices = allOption ? [allOption, ...options] : options;
  if (options.length > 6) {
    const needle = query.trim().toLowerCase();
    // Only text the rows show can match, so every result explains itself.
    const filteredItems = choices.filter((option) =>
      `${option.label} ${option.secondary ?? ""}`.toLowerCase().includes(needle),
    );
    return (
      <Combobox
        items={choices}
        filteredItems={filteredItems}
        filter={null}
        autoHighlight
        itemToStringLabel={(option) => option.label}
        isItemEqualToValue={(a, b) => a.value === b.value}
        value={choices.find((option) => option.value === value) ?? null}
        onOpenChange={(open) => {
          if (!open) setQuery("");
        }}
        onValueChange={(option) => {
          if (option) select(option.value);
        }}
      >
        {trigger}
        <ComboboxPopup align="start" className="w-80">
          <ComboboxSearchInput
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ComboboxEmpty>No matches found.</ComboboxEmpty>
          <ComboboxList>
            {(option: ScopeOption) => (
              <ComboboxItem key={option.value} value={option}>
                <ScopeOptionLabel option={option} />
                {option.value === value ? (
                  <CheckIcon aria-hidden className="size-3.5 shrink-0" />
                ) : null}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    );
  }
  return (
    <Menu>
      {trigger}
      <MenuPopup align="start">
        <div className="w-72 max-w-full">
          <MenuRadioGroup
            value={value}
            onValueChange={(next) => {
              if (typeof next === "string") select(next);
            }}
          >
            {choices.map((option, index) => (
              <Fragment key={option.value}>
                <MenuRadioItem value={option.value} closeOnClick>
                  <span className="flex min-w-0 items-center gap-2">
                    <ScopeOptionLabel option={option} />
                    <MenuRadioItemIndicator />
                  </span>
                </MenuRadioItem>
                {index === 0 && allOption ? <MenuSeparator /> : null}
              </Fragment>
            ))}
          </MenuRadioGroup>
        </div>
      </MenuPopup>
    </Menu>
  );
}

function EnvironmentScopeMenu({
  value,
  groups,
  environments,
  onChange,
  singleEnvironment,
}: SettingsScopeMenuProps) {
  const resolved = resolveSettingsScope(value, groups, environments);
  const environmentValue = environmentAxisValue(
    value,
    resolved.kind === "checkout" ? resolved.environmentId : null,
  );
  const selected = environments.find(
    (environment) => environment.environmentId === environmentValue,
  );
  const project = groups.find((group) => group.projectKey === value.project);
  const memberEnvironmentIds = project
    ? new Set(project.memberProjects.map((member) => member.environmentId))
    : null;
  const options = memberEnvironmentIds
    ? environments.filter((environment) => memberEnvironmentIds.has(environment.environmentId))
    : environments;
  return (
    <ScopeMenu
      id="settings-scope-environment"
      ariaLabel="environment"
      icon={
        selected ? (
          <EnvironmentMachineIcon
            aria-hidden
            kind={resolveEnvironmentMachineKind(selected.serverConfig)}
            className="size-3.5 shrink-0"
          />
        ) : null
      }
      label={
        selected
          ? settingsScopeEnvironmentLabel(selected, environments)
          : environmentValue !== ALL_ENVIRONMENTS_VALUE
            ? "Unavailable environment"
            : singleEnvironment
              ? "No environments"
              : "All environments"
      }
      value={environmentValue}
      onChange={(next) => onChange(selectEnvironmentAxis(value, next))}
      searchLabel="Search environments"
      allOption={
        singleEnvironment
          ? null
          : {
              value: ALL_ENVIRONMENTS_VALUE,
              label: "All environments",
              icon: <LayersIcon aria-hidden className="size-3.5 shrink-0" />,
            }
      }
      options={options.map((environment) => {
        const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
        return {
          value: environment.environmentId,
          label: primary,
          secondary:
            environments.length <= 1
              ? ""
              : secondary || settingsScopeEnvironmentAddress(environment),
          icon: (
            <EnvironmentMachineIcon
              aria-hidden
              kind={resolveEnvironmentMachineKind(environment.serverConfig)}
              className="size-3.5 shrink-0"
            />
          ),
          offline: environment.connection.phase !== "connected",
        };
      })}
    />
  );
}

function ProjectScopeMenu({
  value,
  groups,
  environments,
  onChange,
  focusDefault,
  listing,
  pageLabel,
}: SettingsScopeMenuProps & {
  readonly focusDefault: boolean;
  /** The project list, where the visible lead-in reads "Showing". */
  readonly listing: boolean;
  readonly pageLabel: string | undefined;
}) {
  const selected = groups.find((group) => group.projectKey === value.project);
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  return (
    <ScopeMenu
      id="settings-scope-project"
      focusDefault={focusDefault}
      // Focus can land here after a page change, so the name says which page it is on.
      ariaLabel={
        listing
          ? "projects shown"
          : focusDefault && pageLabel
            ? `project for ${pageLabel} settings`
            : "project"
      }
      icon={selected ? <ProjectFavicon project={selected} className="size-3.5 shrink-0" /> : null}
      label={
        selected?.displayName ??
        (value.project ? (bootstrapped ? "Unavailable project" : "Loading…") : "All projects")
      }
      value={projectAxisValue(value)}
      onChange={(next) => onChange(selectProjectAxis(value, next))}
      searchLabel="Search projects"
      allOption={{ value: ALL_PROJECTS_VALUE, label: "All projects" }}
      options={projectScopeMenuGroups(groups, value).map((group) => {
        // Under an environment filter, locations come from that environment's checkouts only.
        const location =
          settingsScopeProjectDistinction(group, groups, environments, value.machine) ??
          (environments.length > 1 ? settingsScopeProjectPath(group, value.machine) : "");
        return {
          value: group.projectKey,
          label: group.displayName,
          secondary: group.isScratch
            ? SCRATCH_PROJECT_DESCRIPTION
            : [
                ...(group.pinned ? ["Pinned"] : []),
                ...(group.archived ? ["Archived"] : []),
                location,
              ]
                .filter(Boolean)
                .join(" · "),
          icon: <ProjectFavicon project={group} className="size-3.5 shrink-0" />,
        };
      })}
    />
  );
}
