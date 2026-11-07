import { resolveEnvironmentMachineKind } from "@t3tools/contracts";

import type { AppBarMenu } from "../../../components/ui/AppBar.types";
import { ENVIRONMENT_MACHINE_SYMBOLS } from "../../../components/EnvironmentMachineSymbol";
import { useEnvironments } from "../../../state/environments";
import { useSettingsEnvironmentFilter } from "../settings-environment-filter";

/** The settings scope filter, as an `AppBar` menu. */
export function useSettingsEnvironmentMenu(): AppBarMenu {
  const {
    availableTargets,
    selectedTargets,
    selectedIds,
    selectAll,
    toggleEnvironment,
    selectableProjectGroups,
    projectMembersOf,
    selectedProjectKey,
    selectProject,
  } = useSettingsEnvironmentFilter();
  const { environments } = useEnvironments();
  // A project whose checkouts are all on machines that aren't connected can be picked, but its pages
  // can only say why they can't change it. One still loading its settings isn't offline.
  const isOffline = (group: (typeof selectableProjectGroups)[number]) =>
    !projectMembersOf(group).some(
      (project) =>
        environments.find((entry) => entry.environmentId === project.environmentId)?.connection
          .phase === "connected",
    );
  return {
    title: "Filter settings environments and projects",
    icon:
      selectedIds === null && selectedProjectKey === null
        ? "line.3.horizontal.decrease"
        : "line.3.horizontal.decrease.circle.fill",
    items: [
      {
        id: "environments",
        title:
          selectedIds === null
            ? "All environments"
            : `${selectedTargets.length} ${selectedTargets.length === 1 ? "environment" : "environments"}`,
        items: [
          {
            id: "all",
            title: "All environments",
            selected: selectedIds === null,
            onPress: selectAll,
          },
          ...availableTargets.map((entry) => ({
            id: `environment:${entry.environmentId}`,
            title: entry.label,
            icon: ENVIRONMENT_MACHINE_SYMBOLS[resolveEnvironmentMachineKind(entry.serverConfig)],
            subtitle: entry.displayUrl ?? undefined,
            selected: selectedIds === null || selectedIds.has(entry.environmentId),
            onPress: () => toggleEnvironment(entry.environmentId),
          })),
        ],
      },
      {
        id: "projects",
        title:
          selectableProjectGroups.find((group) => group.key === selectedProjectKey)?.label ??
          (selectedProjectKey === null ? "All projects" : "Unavailable project"),
        items: [
          {
            id: "project:all",
            title: "All projects",
            selected: selectedProjectKey === null,
            onPress: () => selectProject(null),
          },
          ...selectableProjectGroups.map((group) => ({
            id: `project:${group.key}`,
            title: projectMenuLabel(group, isOffline(group)),
            selected: selectedProjectKey === group.key,
            onPress: () => selectProject(group.key),
          })),
        ],
      },
    ],
  };
}

const projectMenuLabel = (
  group: { readonly label: string; readonly archived: boolean },
  offline: boolean,
) =>
  [group.label, ...(group.archived ? ["Archived"] : []), ...(offline ? ["Offline"] : [])].join(
    " · ",
  );
