import { workspaceAreaProps } from "../lib/workspaceFocus";
import {
  Navigate,
  Outlet,
  createFileRoute,
  redirect,
  useLocation,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { RotateCcwIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { useSettingsRestore } from "../components/settings/SettingsPanels";

import { AppRouteModal, AppRouteModalClose } from "../components/AppRouteModal";
import { SettingsBreadcrumb } from "../components/settings/SettingsBreadcrumb";
import { SettingsSidebarNav } from "../components/settings/SettingsSidebarNav";
import {
  SettingsScopeProvider,
  useSettingsScope,
} from "../components/settings/SettingsScopeContext";
import { useEnvironments } from "../state/environments";
import { SettingsScopeNotice } from "../components/settings/SettingsScopeNotice";
import {
  SettingsScopeStatus,
  SettingsScopeUnavailable,
} from "../components/settings/SettingsScopeStatus";
import { projectScopeMenuGroups } from "../components/settings/settingsScopeAxis";
import { SETTINGS_DEVICE_ONLY_PATHS } from "../components/settings/SettingsScopeSentence";
import {
  retainSettingsScope,
  validateSettingsRouteSearch,
} from "../components/settings/settingsScopeNavigation";
import {
  getSettingsSearchTargetScope,
  getThreadAutoSettlementSearchAvailability,
  isSettingsSearchScopeAvailable,
  movedSettingsPath,
} from "../components/settings/settingsSearch";

function RestoreDeviceDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="mx-1 size-3.5" />
      <span className="max-sm:sr-only">Restore device defaults</span>
    </Button>
  );
}

function SettingsScopeBoundary({ pathname, children }: { pathname: string; children: ReactNode }) {
  const { scope, connectedEnvironments, groups, search } = useSettingsScope();
  const { environments } = useEnvironments();
  const hash = useLocation({ select: (location) => location.hash });
  const searchTarget = getSettingsSearchTargetScope(hash);
  const autoSettlementAvailability = searchTarget?.requiresThreadAutoSettlement
    ? getThreadAutoSettlementSearchAvailability(environments, scope)
    : null;
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    autoSettlementAvailability &&
    !autoSettlementAvailability.isTargetAvailable
  ) {
    return (
      <SettingsScopeNotice
        target="environment"
        targetId={hash}
        eligibleEnvironmentIds={autoSettlementAvailability.eligibleEnvironmentIds}
      >
        {autoSettlementAvailability.eligibleEnvironmentIds.length > 0
          ? `Choose an environment that supports "${searchTarget.title}".`
          : `"${searchTarget.title}" needs a connected environment running a newer T3 Code.`}
      </SettingsScopeNotice>
    );
  }
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    !isSettingsSearchScopeAvailable(searchTarget.scope, scope.kind)
  ) {
    const target =
      searchTarget.scope === "environment" ||
      searchTarget.scope === "project" ||
      searchTarget.scope === "checkout"
        ? searchTarget.scope
        : "all";
    // With nothing to choose, the project list's own empty state offers the way out.
    if (
      pathname === "/settings/projects" &&
      target === "project" &&
      projectScopeMenuGroups(groups, search).length === 0
    ) {
      return children;
    }
    // The scope line hides a lone environment, so a result that only needs it goes straight there.
    if (target === "environment" && scope.kind === "all" && environments.length === 1) {
      return (
        <Navigate
          to={pathname}
          search={{
            project: undefined,
            machine: environments[0]!.environmentId,
            checkout: undefined,
          }}
          hash={hash}
          replace
        />
      );
    }
    const projectName =
      scope.kind === "project" || scope.kind === "checkout" ? scope.group.displayName : null;
    // A lone environment's settings apply to every project, in the words the scope line uses.
    const shownTarget = target === "environment" && environments.length === 1 ? "all" : target;
    return (
      // Keyed by target so each new search result lands on a fresh list and takes focus.
      <SettingsScopeNotice key={hash} target={shownTarget} targetId={hash}>
        {shownTarget === "all"
          ? `"${searchTarget.title}" applies to every project, so it can't be set for ${projectName ?? "one project"}. Choose all projects to jump to it.`
          : shownTarget === "environment" && projectName
            ? // Choosing an environment leaves the project, so the message says why.
              `"${searchTarget.title}" is set per environment, so it can't be set for ${projectName}. Choose an environment to jump to it.`
            : `Choose ${shownTarget === "environment" ? "an environment" : `a ${shownTarget}`} to jump to "${searchTarget.title}".`}
      </SettingsScopeNotice>
    );
  }
  if (SETTINGS_DEVICE_ONLY_PATHS.has(pathname) || pathname === "/settings/projects") {
    return children;
  }
  // The same notes as the Projects page, so a project reads the same everywhere.
  if (scope.kind === "unavailable") return <SettingsScopeUnavailable />;
  if (scope.kind === "environment" && connectedEnvironments.length === 0) {
    return (
      <SettingsScopeStatus
        message={`Reconnect ${scope.label} to change its settings.`}
        action="reconnect"
      />
    );
  }
  return children;
}

function SettingsContentLayout() {
  const contentArea = workspaceAreaProps("settings", 1, "Settings content");
  const location = useLocation();
  const { search, environment } = useSettingsScope();
  const contentScopeKey =
    location.pathname === "/settings/diagnostics" || location.pathname === "/settings/providers"
      ? environment?.environmentId
      : JSON.stringify(search);
  const [restoreSignal, setRestoreSignal] = useState(0);

  return (
    <AppRouteModal label="Settings">
      <div className="relative flex min-h-0 flex-1">
        <SettingsSidebarNav pathname={location.pathname} />
        <div {...contentArea} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-3 border-b ps-5 pe-2">
            <SettingsBreadcrumb pathname={location.pathname} />
            <div className="ms-auto flex shrink-0 items-center gap-1">
              {location.pathname === "/settings/general" ? (
                <RestoreDeviceDefaultsButton
                  onRestored={() => setRestoreSignal((value) => value + 1)}
                />
              ) : null}
              <AppRouteModalClose />
            </div>
          </header>
          <div key={`${contentScopeKey}:${restoreSignal}`} className="min-h-0 flex flex-1 flex-col">
            <SettingsScopeBoundary pathname={location.pathname}>
              <Outlet />
            </SettingsScopeBoundary>
          </div>
        </div>
      </div>
    </AppRouteModal>
  );
}

function SettingsRouteLayout() {
  const rawSearch = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to router navigation, which React does not own
  useEffect(
    () =>
      router.subscribe("onBeforeNavigate", ({ fromLocation, toLocation }) => {
        if (
          fromLocation?.pathname === toLocation.pathname &&
          fromLocation.searchStr === toLocation.searchStr
        )
          return;
        // History moves (back, forward, mod+[) unmount the page in a commit, which skips blur, so
        // commit-on-blur fields would drop what was typed. Blurring first saves it; refocusing
        // keeps focus recovery for the unmount.
        const field = document.activeElement;
        if (
          (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) &&
          field.closest('[data-workspace-area="settings"]')
        ) {
          field.blur();
          field.focus({ preventScroll: true });
        }
      }),
    [router],
  );
  return (
    <SettingsScopeProvider
      search={rawSearch}
      singleEnvironment={pathname === "/settings/providers" || pathname === "/settings/secrets"}
      onChange={(next) => {
        // Send every axis so retain middleware recognizes "all" as an explicit target.
        void navigate({
          to: pathname,
          search: () => ({
            project: next.project,
            machine: next.machine,
            checkout: next.checkout,
          }),
          // A search result waiting for its scope stays pending until the new scope shows it.
          hash: (previous = "") => (getSettingsSearchTargetScope(previous) ? previous : ""),
          resetScroll: false,
        });
      }}
    >
      <SettingsContentLayout />
    </SettingsScopeProvider>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  validateSearch: validateSettingsRouteSearch,
  search: { middlewares: [retainSettingsScope] },
  beforeLoad: async ({ location }) => {
    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/general", replace: true });
    }
    const moved = movedSettingsPath(location.pathname, location.hash);
    if (moved) throw redirect({ to: moved, search: true, hash: true, replace: true });
  },
  component: SettingsRouteLayout,
});
