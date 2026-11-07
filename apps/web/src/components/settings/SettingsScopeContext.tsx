import { type EnvironmentId, T3_PROJECT_FILE_NAME, type T3ProjectFile } from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { useAtomValue } from "@effect/atom-react";
import { useLocation } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { createContext, type ReactNode, useContext, useState } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { getProjectFileQueryAtom, optimisticFileAtom } from "../files/projectFilesQueryState";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { resolveScopedSettingsTargets, selectScopedSettingsEnvironments } from "./scopedSettings";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import { selectSingleEnvironmentScope } from "./settingsScopeAxis";

type ProjectFileMember = readonly [
  environmentId: EnvironmentId,
  workspaceRoot: string,
  physicalProjectKey: string,
];

const memberProjectFilesAtom = Atom.family((membersKey: string) => {
  const members = JSON.parse(membersKey) as ReadonlyArray<ProjectFileMember>;
  return Atom.make((get) => {
    const files = new Map<string, T3ProjectFile | null>();
    for (const [environmentId, workspaceRoot, physicalProjectKey] of members) {
      const result = get(
        getProjectFileQueryAtom(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME),
      );
      if (result.waiting) continue;
      const data =
        get(optimisticFileAtom(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME))?.data ??
        AsyncResult.getOrElse(result, () => null);
      files.set(
        physicalProjectKey,
        data === null || data.exists === false || data.truncated
          ? null
          : parseT3ProjectFile(data.contents),
      );
    }
    return files;
  }).pipe(Atom.withLabel(`web-settings-member-project-files:${membersKey}`));
});

function useMemberProjectFiles(scope: ReturnType<typeof resolveSettingsScope>) {
  const members = scope.kind === "project" || scope.kind === "checkout" ? scope.members : [];
  return useAtomValue(
    memberProjectFilesAtom(
      JSON.stringify(
        members.map((member): ProjectFileMember => [
          member.environmentId,
          member.workspaceRoot,
          member.physicalProjectKey,
        ]),
      ),
    ),
  );
}

function useResolvedSettingsScope(rawSearch: SettingsScopeSearch, singleEnvironment: boolean) {
  const groups = useSettingsProjectGroups();
  const { environments: availableEnvironments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const search = singleEnvironment
    ? selectSingleEnvironmentScope(
        rawSearch,
        resolveSettingsScope(rawSearch, groups, availableEnvironments),
        availableEnvironments,
        primaryEnvironmentId,
      )
    : rawSearch;
  const scope = resolveSettingsScope(search, groups, availableEnvironments);
  const projectFiles = useMemberProjectFiles(scope);
  const selected = selectScopedSettingsEnvironments(
    scope,
    availableEnvironments,
    primaryEnvironmentId,
  );
  const targets = resolveScopedSettingsTargets(scope, selected.connectedEnvironments, projectFiles);
  const target =
    targets.find((candidate) => candidate.environmentId === selected.environment?.environmentId) ??
    targets[0] ??
    null;
  return { scope, groups, search, ...selected, targets, target };
}

const SettingsScopeContext = createContext<
  | (ReturnType<typeof useResolvedSettingsScope> & {
      singleEnvironment: boolean;
      search: SettingsScopeSearch;
      selectScope: (next: SettingsScopeSearch) => void;
      /** The project most recently open, so the project list can return focus to it. */
      lastProject: string | undefined;
      /** The last scope change closed a project, so the list should show the row just left. */
      returnedFromProject: boolean;
    })
  | null
>(null);

export function SettingsScopeProvider({
  search,
  onChange,
  children,
  singleEnvironment = false,
}: {
  singleEnvironment?: boolean;
  search: SettingsScopeSearch;
  onChange: (next: SettingsScopeSearch) => void;
  children: ReactNode;
}) {
  const resolved = useResolvedSettingsScope(search, singleEnvironment);
  const pathname = useLocation({ select: (location) => location.pathname });
  const hash = useLocation({ select: (location) => location.hash });
  const [seen, setSeen] = useState({ search, pathname, hash });
  const [lastProject, setLastProject] = useState(search.project);
  const [returnedFromProject, setReturnedFromProject] = useState(false);
  if (
    seen.pathname !== pathname ||
    seen.search.project !== search.project ||
    seen.search.machine !== search.machine ||
    seen.search.checkout !== search.checkout
  ) {
    setSeen({ search, pathname, hash });
    // A search result that leaves a project, such as one dropping a missing project's key,
    // brings a target of its own and starts fresh too.
    setReturnedFromProject(
      seen.pathname === pathname && seen.search.project !== undefined && !search.project && !hash,
    );
    if (search.project !== undefined) setLastProject(search.project);
  } else if (seen.hash !== hash) {
    // A new search target on the same page starts fresh instead of returning to the last project.
    setSeen({ search, pathname, hash });
    setReturnedFromProject(false);
  }
  const value = {
    ...resolved,
    singleEnvironment,
    selectScope: onChange,
    lastProject,
    returnedFromProject,
  };
  return <SettingsScopeContext value={value}>{children}</SettingsScopeContext>;
}

export function useOptionalSettingsScope() {
  return useContext(SettingsScopeContext);
}

export function useSettingsScope() {
  const scope = useOptionalSettingsScope();
  if (scope === null) throw new Error("Settings scope must be read inside SettingsScopeProvider.");
  return scope;
}
