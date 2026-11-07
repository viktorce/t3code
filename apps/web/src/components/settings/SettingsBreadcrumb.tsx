import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";

import { useAllEnvironmentShellsBootstrapped } from "../../state/entities";
import { ProjectFavicon } from "../ProjectFavicon";
import { InlineButton } from "../ui/button";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { useSettingsScope } from "./SettingsScopeContext";
import { projectListSearch } from "./settingsScopeNavigation";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = {
  ...SETTINGS_SECTION_LABELS,
  "/settings/diagnostics": "Diagnostics",
  "/settings/open-source-licenses": "Open source licenses",
};

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  const sectionLabel = SETTINGS_BREADCRUMB_LABELS[normalizedPathname] ?? null;
  const { search, groups } = useSettingsScope();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const openProjectKey = normalizedPathname === "/settings/projects" ? search.project : undefined;

  if (openProjectKey) {
    const openProject = groups.find((group) => group.projectKey === openProjectKey);
    // Until environments load, a missing project may only be pending, so it gets no crumb yet.
    const projectLabel = openProject?.displayName ?? (bootstrapped ? "Unavailable project" : null);
    return (
      <WorkspaceBreadcrumb ariaLabel="Settings breadcrumb">
        {/* The root crumb gives way to the back link, so the arrow reads as "back to Projects". */}
        <WorkspaceBreadcrumbItem className="pointer-coarse:-ms-1.5">
          <InlineButton
            tone="muted"
            touchTarget="padded"
            render={
              <Link
                to="/settings/projects"
                search={projectListSearch}
                // The list shares this page's path; only an exact match is the current page.
                activeOptions={{ exact: true }}
              />
            }
          >
            <ArrowLeftIcon aria-hidden className="me-1 size-4" />
            {sectionLabel}
          </InlineButton>
        </WorkspaceBreadcrumbItem>
        {projectLabel === null ? null : (
          <>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="gap-1.5">
              {openProject ? (
                <span aria-hidden className="flex shrink-0">
                  <ProjectFavicon project={openProject} className="size-3.5" />
                </span>
              ) : null}
              <WorkspaceBreadcrumbText>{projectLabel}</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
          </>
        )}
      </WorkspaceBreadcrumb>
    );
  }

  return (
    <WorkspaceBreadcrumb ariaLabel="Settings breadcrumb">
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>Settings</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate">
        {sectionLabel ?? "Settings"}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
