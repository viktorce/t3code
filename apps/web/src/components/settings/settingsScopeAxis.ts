import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { EnvironmentPresentation } from "../../state/environments";
import type { ResolvedSettingsScope, SettingsScopeSearch } from "./settingsScope";

type ScopeEnvironment = Pick<EnvironmentPresentation, "environmentId" | "label" | "displayUrl">;

export function settingsScopeEnvironmentAddress(environment: ScopeEnvironment) {
  if (!environment.displayUrl) return environment.environmentId;
  try {
    return new URL(environment.displayUrl).host || environment.displayUrl;
  } catch {
    return environment.displayUrl;
  }
}

export function settingsScopeEnvironmentLabels(
  environment: ScopeEnvironment,
  environments: readonly ScopeEnvironment[],
) {
  const duplicates = environments.filter(
    (other) =>
      other.environmentId !== environment.environmentId && other.label === environment.label,
  );
  const address = settingsScopeEnvironmentAddress(environment);
  const secondary = duplicates.some((other) => settingsScopeEnvironmentAddress(other) === address)
    ? environment.displayUrl || environment.environmentId
    : address;
  return {
    primary: environment.label,
    secondary: duplicates.length ? secondary : "",
  };
}

export function settingsScopeEnvironmentLabel(
  environment: ScopeEnvironment,
  environments: readonly ScopeEnvironment[],
) {
  const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
  return secondary ? `${primary} · ${secondary}` : primary;
}

const environmentList = new Intl.ListFormat("en", { type: "conjunction" });

export function settingsScopeEnvironmentNames(
  targets: readonly ScopeEnvironment[],
  environments: readonly ScopeEnvironment[],
) {
  return environmentList.format(
    targets.map((entry) => settingsScopeEnvironmentLabel(entry, environments)),
  );
}

export function settingsScopeReconnectMessage(
  targets: readonly ScopeEnvironment[],
  environments: readonly ScopeEnvironment[],
) {
  return `Reconnect ${settingsScopeEnvironmentNames(targets, environments)} to load ${targets.length === 1 ? "its" : "their"} projects.`;
}

function settingsScopeProjectMachines(
  group: SidebarProjectSnapshot,
  environments: readonly ScopeEnvironment[],
) {
  const machines = group.memberProjects.map((member) => {
    const environment = environments.find((entry) => entry.environmentId === member.environmentId);
    return environment
      ? settingsScopeEnvironmentLabel(environment, environments)
      : (member.environmentLabel ?? member.environmentId);
  });
  return Array.from(new Set(machines));
}

// Where a project lives on the chosen environment, or on all of them. The other checkouts are
// counted after the first path; a count before it would read as checkouts inside that folder.
export function settingsScopeProjectPath(
  group: SidebarProjectSnapshot,
  machine: string | undefined,
) {
  const members = machine
    ? group.memberProjects.filter((member) => member.environmentId === machine)
    : group.memberProjects;
  const root = (machine ? members[0]?.workspaceRoot : undefined) ?? group.workspaceRoot;
  const others = members.length - 1;
  return others > 0 ? `${root} and ${others} more checkout${others === 1 ? "" : "s"}` : root;
}

export function settingsScopeSameNameProjects(
  group: SidebarProjectSnapshot,
  groups: readonly SidebarProjectSnapshot[],
) {
  return groups.filter(
    (other) => other.projectKey !== group.projectKey && other.displayName === group.displayName,
  );
}

// What tells a project apart from others with its name: its environments when they differ,
// else its path. Null when no other project shares the name.
export function settingsScopeProjectDistinction(
  group: SidebarProjectSnapshot,
  groups: readonly SidebarProjectSnapshot[],
  environments: readonly ScopeEnvironment[],
  machine: string | undefined,
) {
  const sameName = settingsScopeSameNameProjects(group, groups);
  if (sameName.length === 0) return null;
  const machinesOf = (candidate: SidebarProjectSnapshot) =>
    settingsScopeProjectMachines(
      machine
        ? {
            ...candidate,
            memberProjects: candidate.memberProjects.filter(
              (member) => member.environmentId === machine,
            ),
          }
        : candidate,
      environments,
    ).join(", ");
  const machines = machinesOf(group);
  return sameName.some((other) => machinesOf(other) === machines)
    ? settingsScopeProjectPath(group, machine)
    : machines;
}

export const ALL_ENVIRONMENTS_VALUE = "all";
export const ALL_PROJECTS_VALUE = "all";
export const SCRATCH_PROJECT_DESCRIPTION = "Threads started without a project";

export function environmentAxisValue(
  search: SettingsScopeSearch,
  resolvedEnvironmentId?: string | null,
): string {
  return search.machine ?? resolvedEnvironmentId ?? ALL_ENVIRONMENTS_VALUE;
}

export function projectAxisValue(search: SettingsScopeSearch): string {
  return search.project ?? ALL_PROJECTS_VALUE;
}

export function projectScopeMenuGroups(
  groups: readonly SidebarProjectSnapshot[],
  search: Pick<SettingsScopeSearch, "machine">,
) {
  const { machine } = search;
  if (machine === undefined) return groups;
  return groups.filter((group) =>
    group.memberProjects.some((member) => member.environmentId === machine),
  );
}

export function selectEnvironmentAxis(
  search: SettingsScopeSearch,
  value: string,
): SettingsScopeSearch {
  const next: SettingsScopeSearch = {};
  if (search.project) next.project = search.project;
  if (value !== ALL_ENVIRONMENTS_VALUE) next.machine = value;
  return next;
}

export function selectProjectAxis(search: SettingsScopeSearch, value: string): SettingsScopeSearch {
  const next: SettingsScopeSearch = {};
  if (value !== ALL_PROJECTS_VALUE) next.project = value;
  if (search.machine) next.machine = search.machine;
  return next;
}

export function selectSingleEnvironmentScope(
  search: SettingsScopeSearch,
  scope: ResolvedSettingsScope,
  environments: readonly {
    readonly environmentId: EnvironmentPresentation["environmentId"];
    readonly connection: Pick<EnvironmentPresentation["connection"], "phase">;
  }[],
  primaryEnvironmentId: string | null,
): SettingsScopeSearch {
  if (search.machine || scope.kind === "unavailable") return search;
  const selectedIds = new Set(scope.environmentIds);
  const candidates = environments.filter((environment) =>
    selectedIds.has(environment.environmentId),
  );
  const selected =
    candidates.find((environment) => environment.environmentId === primaryEnvironmentId) ??
    candidates.find((environment) => environment.connection.phase === "connected") ??
    candidates[0];
  return selected ? { ...search, machine: selected.environmentId } : search;
}
