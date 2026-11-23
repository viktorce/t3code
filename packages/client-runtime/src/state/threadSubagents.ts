import * as DateTime from "effect/DateTime";
import type {
  EnvironmentId,
  NodeId,
  OrchestrationV2RemoteTaskChild,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  ScopedThreadRef,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { copySorted } from "@t3tools/shared/Array";

import type { ThreadStructure } from "./shell.ts";
import { isActiveSubagentStatus, isTerminalSubagentStatus } from "./subagentRuntime.ts";
import { resolveActiveThreadRun } from "./threadWorkflows.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

type Projection = OrchestrationV2ThreadProjection;
type Subagent = OrchestrationV2Subagent;
type RunId = Projection["runs"][number]["id"];

export interface ThreadTurnSubagents {
  readonly runId: RunId | null;
  readonly turnActive: boolean;
  /** No later turn has run since these agents' turn. */
  readonly latestTurn: boolean;
  readonly subagents: ReadonlyArray<Subagent>;
  readonly liveCount: number;
  readonly settledCount: number;
}

export interface SubagentPillSegment {
  readonly label: string;
  readonly accessibilityLabel: string;
}

function orderKey(subagent: Subagent): number {
  return DateTime.toEpochMillis(subagent.startedAt ?? subagent.updatedAt);
}

export function deriveThreadTurnSubagents(
  projection: Pick<Projection, "runs" | "subagents">,
): ThreadTurnSubagents | null {
  const rolledBackRunIds = new Set(
    projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
  );
  const eligible = projection.subagents.filter(
    (subagent) => subagent.runId === null || !rolledBackRunIds.has(subagent.runId),
  );
  const [first] = eligible;
  if (first === undefined) return null;
  const activeRun = resolveActiveThreadRun(projection);
  const latestUpdated = eligible.reduce(
    (latest, subagent) =>
      DateTime.toEpochMillis(subagent.updatedAt) > DateTime.toEpochMillis(latest.updatedAt)
        ? subagent
        : latest,
    first,
  );
  // Ordinal, not array position: a reordered queue can leave the projection's runs out of order.
  // Queued and never-started runs have not replaced anything yet.
  const latestStartedRun = projection.runs.reduce<Projection["runs"][number] | null>(
    (latest, run) =>
      run.startedAt !== null &&
      !rolledBackRunIds.has(run.id) &&
      (latest === null || run.ordinal > latest.ordinal)
        ? run
        : latest,
    null,
  );
  const latestStartedRunHasAgents =
    latestStartedRun !== null &&
    eligible.some((subagent) => subagent.runId === latestStartedRun.id);
  const runId =
    activeRun?.id ?? (latestStartedRunHasAgents ? latestStartedRun.id : latestUpdated.runId);
  const subagents = copySorted(
    eligible.filter(
      (subagent) =>
        subagent.runId === runId ||
        isActiveSubagentStatus(subagent.status) ||
        subagent.workflow !== undefined,
    ),
    (left, right) => orderKey(left) - orderKey(right) || left.id.localeCompare(right.id),
  );
  if (subagents.length === 0) return null;

  let liveCount = 0;
  let settledCount = 0;
  for (const subagent of subagents) {
    if (isActiveSubagentStatus(subagent.status)) liveCount += 1;
    else if (isTerminalSubagentStatus(subagent.status)) settledCount += 1;
  }
  return {
    runId,
    turnActive: activeRun !== null,
    latestTurn: runId === null || latestStartedRun === null || runId === latestStartedRun.id,
    subagents,
    liveCount,
    settledCount,
  };
}

export function resolveSubagentPillSegment(
  turn: ThreadTurnSubagents | null,
  resolve: MFunctionType = mFallback,
): SubagentPillSegment | null {
  if (turn === null) return null;
  // Finished agents stay reachable until a later turn replaces them; workflows always stay reachable.
  if (
    !turn.turnActive &&
    !turn.latestTurn &&
    turn.liveCount === 0 &&
    !turn.subagents.some((subagent) => subagent.workflow !== undefined)
  ) {
    return null;
  }
  const total = turn.subagents.length;
  if (turn.liveCount > 0) {
    return {
      label: `${turn.liveCount}/${total}`,
      accessibilityLabel: resolve(
        msg("{live} of {total} agents working", { live: turn.liveCount, total }),
      ),
    };
  }
  return {
    label: resolve(msg("{count} done", { count: turn.settledCount })),
    accessibilityLabel: resolve(
      msg("{count, plural, one {{count} agent done} other {{count} agents done}}", {
        count: turn.settledCount,
      }),
    ),
  };
}

interface SubagentChild {
  readonly threadId: ThreadId;
  /** Set when the task ran on a linked environment, which holds its thread. */
  readonly environmentId?: EnvironmentId;
  readonly title: string | null | undefined;
}

export interface ResponseSubagent {
  readonly threadId: ThreadId;
  readonly title: string;
  /** Set when the task ran on a linked environment, which holds its thread. */
  readonly environmentId?: EnvironmentId;
}

/**
 * The subagents a response reported on. A result reaches the thread as a message from the
 * subagent's thread or as a completion notice, at the start of a run or steered into one, so the
 * inputs just before the response decide it. Turn items are read because older history loads
 * nothing else.
 */
export function deriveResponseSubagents(
  projection: Pick<ThreadStructure, "visibleTurnItems" | "subagents" | "messages"> | undefined,
  environmentId: EnvironmentId,
  itemId: TurnItemId,
  readThreadTitle: (ref: ScopedThreadRef) => string | null | undefined,
): ReadonlyArray<ResponseSubagent> {
  if (!projection) return [];
  const items = projection.visibleTurnItems;
  const isInput = (index: number) => {
    const type = items[index]?.item.type;
    return type === "user_message" || type === "notification";
  };
  let index = items.findIndex((projected) => projected.sourceItemId === itemId) - 1;
  while (index >= 0 && !isInput(index)) index -= 1;

  const byTask = new Map<NodeId, SubagentChild>();
  const local = new Map<ThreadId, SubagentChild>();
  const remember = (
    taskId: NodeId,
    childThreadId: ThreadId | null,
    remote: OrchestrationV2RemoteTaskChild | undefined,
    title: string | null,
  ) => {
    if (childThreadId !== null) {
      const child = { threadId: childThreadId, title };
      byTask.set(taskId, child);
      local.set(childThreadId, child);
    } else if (remote) {
      // A task sent to a linked environment has no thread here; its thread lives there.
      const { threadId, environmentId: remoteEnvironmentId } = remote;
      byTask.set(taskId, {
        threadId,
        environmentId: remoteEnvironmentId,
        title: title ?? remote.title,
      });
    }
  };
  for (const { item } of items) {
    if (item.type === "subagent") {
      remember(item.subagentId, item.childThreadId, item.remoteChild, null);
    }
  }
  for (const subagent of projection.subagents) {
    remember(subagent.id, subagent.childThreadId, subagent.remoteChild, subagent.title);
  }

  const found = new Map<string, SubagentChild>();
  const add = (child: SubagentChild | undefined) => {
    if (child) found.set(`${child.environmentId ?? ""}:${child.threadId}`, child);
  };
  for (; index >= 0 && isInput(index); index -= 1) {
    const item = items[index]!.item;
    if (item.type === "notification") {
      // A notice names its child itself, so it counts even when the task is no longer loaded.
      if ("childThreadId" in item.source && item.source.childThreadId !== undefined) {
        const threadId = item.source.childThreadId;
        add(local.get(threadId) ?? { threadId, title: null });
      }
      for (const taskId of "taskIds" in item.source ? item.source.taskIds : []) {
        add(byTask.get(taskId));
      }
    } else if (item.type === "user_message") {
      const message = projection.messages.find(({ id }) => id === item.messageId);
      for (const taskId of message?.delegatedCompletion?.taskIds ?? []) add(byTask.get(taskId));
      // A sender counts only as this thread's subagent: a child's first message comes from its parent.
      if (item.senderThreadId !== undefined) add(local.get(item.senderThreadId));
    }
  }
  return [...found.values()].map(({ title, ...child }) => ({
    ...child,
    title:
      title?.trim() ||
      readThreadTitle({
        environmentId: child.environmentId ?? environmentId,
        threadId: child.threadId,
      })?.trim() ||
      // oxlint-disable-next-line t3code/no-untranslated-copy -- subagent title stored in the reply record sent to the agent
      "Agent",
  }));
}
