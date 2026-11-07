import { Link, useLocation } from "@tanstack/react-router";
import { ArrowLeftIcon, LayersIcon, PlusIcon } from "lucide-react";
import { useId } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useEnvironments } from "../../state/environments";
import {
  useEnvironmentShellsBootstrapped,
  useUnloadedShellEnvironmentIds,
} from "../../state/shell";
import { Button } from "../ui/button";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  CancelSearchButton,
  claimSearchFocus,
  OpenEnvironmentsButton,
} from "./SettingsScopeNotice";
import { SettingsPageContainer } from "./settingsLayout";
import { getSettingsSearchTargetScope } from "./settingsSearch";
import {
  ALL_ENVIRONMENTS_VALUE,
  ALL_PROJECTS_VALUE,
  selectEnvironmentAxis,
  selectProjectAxis,
  settingsScopeReconnectMessage,
} from "./settingsScopeAxis";
import { projectListSearch } from "./settingsScopeNavigation";

/** A page-sized note for a selection that shows nothing, with each way on that it allows. */
export function SettingsScopeStatus({
  message,
  action,
}: {
  message: string;
  action?: "add-project" | "reconnect";
}) {
  const { search, scope, selectScope } = useSettingsScope();
  const { environments } = useEnvironments();
  const pathname = useLocation({ select: (location) => location.pathname });
  const hash = useLocation({ select: (location) => location.hash });
  const searchTarget = getSettingsSearchTargetScope(hash);
  // An empty project list still shows a waiting search result's message and a way to drop it,
  // since choosing a project later would finish that search.
  const pendingProjectSearch =
    pathname === "/settings/projects" &&
    scope.kind !== "unavailable" &&
    searchTarget?.scope === "project"
      ? searchTarget.title
      : null;
  const projectMissing = scope.kind === "unavailable" && scope.reason === "project-missing";
  // A pending environment cannot prove that a project is gone or that a list is empty. A note
  // about one environment waits only for it; a missing project could be on any of them.
  const environment = projectMissing
    ? undefined
    : environments.find((entry) => entry.environmentId === search.machine);
  const bootstrapped = useEnvironmentShellsBootstrapped(environment?.environmentId ?? null);
  const messageId = useId();
  // A new search result that waits here takes focus once, as a list's first choice would;
  // loading and later updates, including the list that replaces this note, leave it alone.
  const visit = useLocation({ select: (location) => location.state.__TSR_key });
  const takeSearchFocus = (button: HTMLElement | null) => {
    if (button && claimSearchFocus(visit)) button.focus({ preventScroll: true });
  };
  // The project lookup ignores the environment, so dropping it cannot bring a project back. A
  // filter on the only environment already shows all there is.
  const offerAllEnvironments =
    Boolean(search.machine || search.checkout) &&
    !projectMissing &&
    !(
      environments.length === 1 &&
      !search.checkout &&
      search.machine === environment?.environmentId
    );
  // Every note offers a way on, and its first button takes focus that the page change drops.
  return (
    <SettingsPageContainer className="gap-6">
      <div className="flex flex-col items-start gap-3 px-3 sm:px-4">
        {pendingProjectSearch ? (
          <p className="text-sm text-foreground pointer-coarse:leading-8">
            <span id={`${messageId}-search`}>
              {`Choose a project to jump to "${pendingProjectSearch}".`}
            </span>{" "}
            <CancelSearchButton
              ref={takeSearchFocus}
              data-workspace-focus-default
              aria-describedby={`${messageId}-search ${messageId}`}
            />
          </p>
        ) : null}
        {/* The same live node shows loading and then the note, so the change is announced. */}
        <p
          id={messageId}
          role="status"
          aria-atomic="true"
          className="text-sm text-muted-foreground"
        >
          {bootstrapped ? message : scope.kind === "environment" ? "Loading…" : "Loading projects…"}
        </p>
        {bootstrapped ? (
          <div className="flex flex-wrap gap-2">
            {projectMissing ? (
              pathname === "/settings/projects" ? (
                <Button
                  variant="outline"
                  size="sm"
                  data-workspace-focus-default
                  aria-describedby={messageId}
                  render={
                    <Link
                      to="/settings/projects"
                      search={projectListSearch}
                      // The list shares this page's path; only an exact match is the current page.
                      activeOptions={{ exact: true }}
                    />
                  }
                >
                  <ArrowLeftIcon />
                  Back to projects
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  data-workspace-focus-default
                  aria-describedby={messageId}
                  onClick={() => selectScope(selectProjectAxis(search, ALL_PROJECTS_VALUE))}
                >
                  <LayersIcon />
                  Show all projects
                </Button>
              )
            ) : null}
            {offerAllEnvironments ? (
              <Button
                variant="outline"
                size="sm"
                data-workspace-focus-default
                aria-describedby={messageId}
                onClick={() => selectScope(selectEnvironmentAxis(search, ALL_ENVIRONMENTS_VALUE))}
              >
                <LayersIcon />
                Show all environments
              </Button>
            ) : null}
            {action === "reconnect" ? (
              <OpenEnvironmentsButton data-workspace-focus-default aria-describedby={messageId} />
            ) : null}
            {action === "add-project" ? (
              <Button
                variant="outline"
                size="sm"
                data-workspace-focus-default
                aria-describedby={messageId}
                onClick={() =>
                  openCommandPalette({
                    open: "add-project",
                    ...(environment ? { environmentId: environment.environmentId } : {}),
                  })
                }
              >
                <PlusIcon />
                Add project
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </SettingsPageContainer>
  );
}

/** The note for a selection that resolves to nothing, on every page that has a scope. */
export function SettingsScopeUnavailable() {
  const { search, scope } = useSettingsScope();
  const { environments } = useEnvironments();
  // A disconnected environment that never loaded cannot prove a project is gone either.
  const unloadedIds = useUnloadedShellEnvironmentIds();
  if (scope.kind !== "unavailable") return null;
  const unloaded = environments.filter((entry) => unloadedIds.has(entry.environmentId));
  const environment = environments.find((entry) => entry.environmentId === search.machine);
  if (scope.reason === "project-missing" && unloaded.length > 0)
    return (
      <SettingsScopeStatus
        message={settingsScopeReconnectMessage(unloaded, environments)}
        action="reconnect"
      />
    );
  if (
    scope.reason === "checkout-missing" &&
    environment &&
    unloadedIds.has(environment.environmentId)
  )
    return (
      <SettingsScopeStatus
        message={settingsScopeReconnectMessage([environment], environments)}
        action="reconnect"
      />
    );
  return <SettingsScopeStatus message={scope.message} />;
}
