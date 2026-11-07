import { EnvironmentId } from "@t3tools/contracts";

import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useUnloadedShellEnvironmentIds } from "../../state/shell";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsScopeStatus, SettingsScopeUnavailable } from "./SettingsScopeStatus";
import {
  projectScopeMenuGroups,
  settingsScopeEnvironmentLabel,
  settingsScopeReconnectMessage,
} from "./settingsScopeAxis";

export function ProjectsSettings() {
  const { search: value, scope, groups } = useSettingsScope();
  const { environments } = useEnvironments();
  // A disconnected environment that never loaded cannot prove the list is empty.
  const unloadedIds = useUnloadedShellEnvironmentIds();
  const listedGroups = projectScopeMenuGroups(groups, value);
  const environment = environments.find((entry) => entry.environmentId === value.machine);
  const unloaded = environments.filter((entry) => unloadedIds.has(entry.environmentId));
  const machineUnloaded = environment ? unloadedIds.has(environment.environmentId) : false;
  const reconnect = (targets: readonly EnvironmentPresentation[]) => (
    <SettingsScopeStatus
      message={settingsScopeReconnectMessage(targets, environments)}
      action="reconnect"
    />
  );
  const unavailable = scope.kind === "unavailable" ? <SettingsScopeUnavailable /> : null;
  // Keep the panel mounted so it can follow members when regrouping changes the project key.
  const projectScope =
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    (scope.kind === "unavailable" &&
      (scope.reason === "project-missing" || scope.reason === "checkout-missing"));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {value.project && projectScope ? (
        <ProjectSettingsPanel
          projectKey={value.project}
          environmentId={value.machine ? EnvironmentId.make(value.machine) : null}
          checkoutKey={value.checkout ?? null}
          unavailable={unavailable}
        />
      ) : unavailable ? (
        unavailable
      ) : value.machine && listedGroups.length === 0 ? (
        environment && machineUnloaded ? (
          reconnect([environment])
        ) : (
          <SettingsScopeStatus
            message={`No projects on ${environment ? settingsScopeEnvironmentLabel(environment, environments) : "this environment"}.`}
            action="add-project"
          />
        )
      ) : listedGroups.length === 0 ? (
        unloaded.length > 0 ? (
          reconnect(unloaded)
        ) : (
          <SettingsScopeStatus message="No projects yet." action="add-project" />
        )
      ) : (
        <SettingsScopeNotice target="project">
          Choose a project to manage its name, icon, new-thread defaults, actions and checkouts.
        </SettingsScopeNotice>
      )}
    </div>
  );
}
