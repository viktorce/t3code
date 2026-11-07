import { AuthOrchestrationOperateScope, EnvironmentId } from "@t3tools/contracts";
import { LayersIcon, Trash2Icon } from "lucide-react";
import { useRef } from "react";

import { useEnvironmentsWithScope } from "../../state/session";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useProjectRemoval } from "./ProjectRemovalDialog";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsPageContainer } from "./settingsLayout";
import { ALL_ENVIRONMENTS_VALUE, selectEnvironmentAxis } from "./settingsScopeAxis";

export function ProjectsSettings() {
  const { search: value, scope, selectScope, groups } = useSettingsScope();
  const { requestRemoval, removalDialog, removalOpen } = useProjectRemoval();
  const operableIds = useEnvironmentsWithScope(
    groups.flatMap((group) => group.memberProjects),
    AuthOrchestrationOperateScope,
  );
  const listRef = useRef<HTMLDivElement>(null);
  // The row that moves into the removed project's place: the next one, or the previous one.
  const focusRowReplacing = (projectKey: string) => {
    const index = groups.findIndex((group) => group.projectKey === projectKey);
    const nextKey = (groups[index + 1] ?? groups[index - 1])?.projectKey;
    return () =>
      nextKey === undefined
        ? null
        : (listRef.current?.querySelector<HTMLElement>(
            `[data-project-key="${CSS.escape(nextKey)}"]`,
          ) ?? null);
  };
  const unavailable =
    scope.kind === "unavailable" ? (
      <SettingsPageContainer>
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">{scope.message}</p>
          {value.machine || value.checkout ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => selectScope(selectEnvironmentAxis(value, ALL_ENVIRONMENTS_VALUE))}
            >
              <LayersIcon />
              Show all environments
            </Button>
          ) : null}
        </div>
      </SettingsPageContainer>
    ) : null;
  // Keep the panel mounted so it can follow members when regrouping changes the project key.
  const projectScope =
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    (scope.kind === "unavailable" &&
      (scope.reason === "project-missing" || scope.reason === "checkout-missing"));
  return (
    <div ref={listRef} className="flex min-h-0 flex-1 flex-col">
      {value.project && projectScope ? (
        <ProjectSettingsPanel
          projectKey={value.project}
          environmentId={value.machine ? EnvironmentId.make(value.machine) : null}
          checkoutKey={value.checkout ?? null}
          unavailable={unavailable}
          onRemove={requestRemoval}
          removalOpen={removalOpen}
        />
      ) : unavailable ? (
        unavailable
      ) : (
        <SettingsScopeNotice
          target="project"
          renderProjectAction={(group, descriptionId) =>
            group.memberProjects.every((member) => operableIds.has(member.environmentId)) ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-destructive"
                      aria-label={`Remove ${group.displayName}`}
                      aria-describedby={descriptionId}
                      onClick={() =>
                        requestRemoval({
                          group,
                          members: group.memberProjects,
                          hasOtherMembers: false,
                          focusAfterRemoval: focusRowReplacing(group.projectKey),
                        })
                      }
                    />
                  }
                >
                  <Trash2Icon aria-hidden />
                </TooltipTrigger>
                <TooltipPopup>Remove project</TooltipPopup>
              </Tooltip>
            ) : null
          }
        >
          {groups.length > 0
            ? "Choose a project to manage its name, icon, checkouts and actions."
            : "Add a project from the sidebar to configure it here."}
        </SettingsScopeNotice>
      )}
      {removalDialog}
    </div>
  );
}
