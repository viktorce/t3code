import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";

import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import type { Project } from "../types";
import {
  buildCommandPaletteProjectMetadata,
  buildProjectActionItems,
  type CommandPaletteItemPin,
  type CommandPaletteItemRemove,
  type CommandPaletteProject,
  ITEM_ICON_CLASS,
} from "./CommandPalette.logic";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { ProjectFavicon } from "./ProjectFavicon";
import { MiddleTruncate } from "./ui/middle-truncate";
import { COMMAND_PALETTE_META_ICON_CLASS, CommandPaletteMetaDot } from "./ThreadCommandSubtitle";

export interface CommandPaletteProjectLocation {
  readonly kind: "local" | "remote";
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
}

const UNKNOWN_PROJECT_LOCATION: CommandPaletteProjectLocation = {
  kind: "remote",
  label: "Remote",
  machine: "server",
};

interface ProjectItemsInput {
  readonly projects: ReadonlyArray<CommandPaletteProject>;
  readonly projectGroupByTargetKey: ReadonlyMap<string, SidebarProjectSnapshot>;
  readonly locationByEnvironmentId: ReadonlyMap<EnvironmentId, CommandPaletteProjectLocation>;
  readonly runProject: (project: CommandPaletteProject) => Promise<void>;
  readonly pin?: (project: CommandPaletteProject) => CommandPaletteItemPin | null;
  readonly remove?: (project: CommandPaletteProject) => CommandPaletteItemRemove | null;
}

function projectFaviconIcon(project: Project) {
  return <ProjectFavicon project={project} className={ITEM_ICON_CLASS} />;
}

/** Projects as root search results; a grouped project matches on every member. */
export function buildProjectSearchItems(input: ProjectItemsInput) {
  const membersOf = (project: CommandPaletteProject) =>
    input.projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`)?.memberProjects ?? [
      project,
    ];
  return buildProjectActionItems({
    projects: input.projects,
    valuePrefix: "project",
    searchTerms: (project) =>
      buildCommandPaletteProjectMetadata({
        projects: membersOf(project),
        locationByEnvironmentId: input.locationByEnvironmentId,
      }).searchTerms,
    renderDescription: (project) => {
      const members = membersOf(project);
      const metadata = buildCommandPaletteProjectMetadata({
        projects: members,
        locationByEnvironmentId: input.locationByEnvironmentId,
      });
      return members.length > 1 ? (
        <GroupedProjectDescription places={metadata.environmentLabels} count={members.length} />
      ) : (
        <ProjectLocationDescription
          location={input.locationByEnvironmentId.get(project.environmentId)}
          workspaceRoot={project.workspaceRoot}
        />
      );
    },
    icon: projectFaviconIcon,
    runProject: input.runProject,
    ...(input.pin ? { pin: input.pin } : {}),
    ...(input.remove ? { remove: input.remove } : {}),
  });
}

/** Projects as targets of the "New thread in..." submenu. */
export function buildNewThreadInProjectItems(input: ProjectItemsInput) {
  return buildProjectActionItems({
    projects: input.projects,
    valuePrefix: "new-thread-in",
    searchTerms: (project) => {
      const group = input.projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
      const location = input.locationByEnvironmentId.get(project.environmentId);
      return [
        ...(group?.memberProjects.flatMap((member) => [member.title, member.workspaceRoot]) ?? []),
        ...(location ? [location.label] : []),
      ];
    },
    renderDescription: (project) => {
      const checkoutCount =
        input.projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`)?.memberProjects
          .length ?? 1;
      // The new thread starts in this checkout, but the row's trash removes every one.
      return (
        <ProjectLocationDescription
          location={input.locationByEnvironmentId.get(project.environmentId)}
          workspaceRoot={project.workspaceRoot}
          {...(checkoutCount > 1 ? { suffix: `${checkoutCount} checkouts` } : {})}
        />
      );
    },
    icon: projectFaviconIcon,
    runProject: input.runProject,
    ...(input.pin ? { pin: input.pin } : {}),
    ...(input.remove ? { remove: input.remove } : {}),
  });
}

/** Projects as targets of "Remove project...", where choosing one asks to confirm. */
export function buildRemoveProjectItems(
  input: Omit<ProjectItemsInput, "pin" | "remove"> & { readonly query: string },
) {
  const groupOf = (project: CommandPaletteProject) =>
    input.projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
  const membersOf = (project: CommandPaletteProject) =>
    groupOf(project)?.memberProjects ?? [project];
  const pathQuery = /[/\\]/.test(input.query) ? input.query.trim().toLowerCase() : "";
  return buildProjectActionItems({
    projects: input.projects,
    valuePrefix: "remove-project",
    searchTerms: (project) => [
      ...buildCommandPaletteProjectMetadata({
        projects: membersOf(project),
        locationByEnvironmentId: input.locationByEnvironmentId,
      }).searchTerms,
      ...(groupOf(project)?.archived ? ["archived"] : []),
    ],
    renderDescription: (project) => {
      const members = membersOf(project);
      const archived = groupOf(project)?.archived === true;
      if (members.length === 1) {
        return (
          <span className="flex min-w-0 items-center gap-1">
            {archived ? (
              <>
                <span className="shrink-0">Archived</span>
                <CommandPaletteMetaDot />
              </>
            ) : null}
            {/* The end of a path tells same-named projects apart, so it is the part that stays. */}
            <ProjectLocationDescription
              location={input.locationByEnvironmentId.get(project.environmentId)}
              workspaceRoot={project.workspaceRoot}
              keepPathEnd
            />
          </span>
        );
      }
      const places = [
        ...(archived ? ["Archived"] : []),
        ...buildCommandPaletteProjectMetadata({
          projects: members,
          locationByEnvironmentId: input.locationByEnvironmentId,
        }).environmentLabels,
      ];
      // A path search that finds one checkout names it, so the row shows why it matched.
      const matching = pathQuery
        ? members.filter((member) => member.workspaceRoot.toLowerCase().includes(pathQuery))
        : [];
      // Removal takes every checkout, so the row says where and how many before the dialog does.
      return (
        <GroupedProjectDescription
          places={places}
          count={members.length}
          {...(matching.length === 1 ? { including: matching[0]!.workspaceRoot } : {})}
        />
      );
    },
    icon: projectFaviconIcon,
    runProject: input.runProject,
    keepOpen: true,
  });
}

/** A grouped row's places and checkout count; the count always shows, and a path gives way first. */
function GroupedProjectDescription(props: {
  readonly places: ReadonlyArray<string>;
  readonly count: number;
  readonly including?: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      {props.places.length > 0 ? (
        <>
          <span className={props.including ? "max-w-1/2 shrink-0 truncate" : "truncate"}>
            {props.places.join(" · ")}
          </span>
          <CommandPaletteMetaDot />
        </>
      ) : null}
      <span className="shrink-0">
        {props.count} checkouts{props.including ? ", including" : ""}
      </span>
      {props.including ? <MiddleTruncate value={props.including} /> : null}
    </span>
  );
}

function ProjectLocationDescription(props: {
  readonly location: CommandPaletteProjectLocation | undefined;
  readonly workspaceRoot: string;
  readonly keepPathEnd?: boolean;
  readonly suffix?: string;
}) {
  const location = props.location ?? UNKNOWN_PROJECT_LOCATION;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {/* The path gives way first, so a long path never squeezes the label to "Lo…". */}
      <span className="inline-flex max-w-1/2 shrink-0 items-center gap-1">
        {location.kind === "remote" ? (
          <EnvironmentMachineIcon
            aria-hidden
            kind={location.machine}
            className={COMMAND_PALETTE_META_ICON_CLASS}
          />
        ) : null}
        <span className="truncate">{location.label}</span>
      </span>
      <CommandPaletteMetaDot />
      {props.keepPathEnd ? (
        <MiddleTruncate value={props.workspaceRoot} />
      ) : (
        <span className="truncate">{props.workspaceRoot}</span>
      )}
      {props.suffix ? (
        <>
          <CommandPaletteMetaDot />
          <span className="shrink-0">{props.suffix}</span>
        </>
      ) : null}
    </span>
  );
}
