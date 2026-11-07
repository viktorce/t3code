import { type TimestampFormat } from "@t3tools/contracts/settings";
import { CloudIcon, CloudOffIcon } from "lucide-react";
import { useState, type ReactElement } from "react";
import { formatShortTimestamp } from "../../timestampFormat";
import { InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type Scope = "thread" | "all";

type RecoveryProps = {
  runId: string;
  machineName: string;
  providerName: string;
  stoppedAt: string;
  /** The server reached the provider again, and this thread is not set to auto-resume. */
  reachable: boolean;
  scheduled: boolean;
  /** Auto-resume stopped after its last allowed attempt failed on the same outage. */
  gaveUp: boolean;
  /** Threads on this machine and provider that stopped on the outage, this one included. */
  stoppedCount: number;
  scheduledCount: number;
  timestampFormat: TimestampFormat;
  onAutoResumeChange: (scope: Scope, autoResume: boolean) => Promise<void>;
  onResumeNow: (scope: Scope) => Promise<void>;
};

export function connectionRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const { machineName, providerName, reachable, scheduled, gaveUp } = props;
  const { stoppedCount, scheduledCount } = props;
  const unarmedOthers = stoppedCount - scheduledCount - (scheduled ? 0 : 1);
  const stopped =
    stoppedCount === 1
      ? `Stopped ${formatShortTimestamp(props.stoppedAt, props.timestampFormat)}`
      : scheduledCount > 0
        ? `${stoppedCount} threads stopped, ${scheduledCount} set to auto-resume`
        : `${stoppedCount} threads stopped`;
  const base = {
    id: `connection-recovery:${props.runId}`,
    group: "environment",
    actions: <RecoveryActions key={`${props.runId}:${reachable}:${gaveUp}`} {...props} />,
    wrapActions: true,
  } as const;
  if (reachable) {
    return {
      ...base,
      // Still amber: the threads wait for the user to resume them.
      variant: "warning",
      icon: <CloudIcon />,
      title: `${machineName} can reach ${providerName} again`,
      description: stopped,
    };
  }
  return {
    ...base,
    // Armed threads need nothing from the user, so the notice stops asking for attention.
    variant: scheduled ? "info" : "warning",
    icon: <CloudOffIcon />,
    title: `${machineName} can't reach ${providerName}`,
    description: scheduled
      ? scheduledCount === stoppedCount
        ? stoppedCount > 1
          ? `${stoppedCount} threads resume when reachable`
          : "Resumes when reachable"
        : `Resumes when reachable, ${unarmedOthers} more stopped`
      : gaveUp
        ? "Auto-resume stopped after 3 failed resumes"
        : stopped,
  };
}

function RecoveryActions(props: RecoveryProps) {
  const { machineName, providerName, reachable, scheduled } = props;
  const { stoppedCount, scheduledCount } = props;
  const [pending, setPending] = useState<string | null>(null);
  const unarmed = stoppedCount - scheduledCount;
  async function run(label: string, failureTitle: string, action: () => Promise<void>) {
    setPending(label);
    try {
      await action();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    }
    setPending(null);
  }
  const button = (label: string, failureTitle: string, action: () => Promise<void>) => (
    <InlineButton
      key={label}
      touchTarget="padded"
      disabled={pending !== null}
      onClick={() => void run(label, failureTitle, action)}
    >
      {pending === label ? (reachable ? "Resuming..." : "Saving...") : label}
    </InlineButton>
  );
  // "All" reaches threads in other projects, so the bulk actions say where they look.
  const scoped = (element: ReactElement) => (
    <Tooltip key={element.key}>
      <TooltipTrigger render={element} />
      <TooltipPopup>{`Includes stopped threads in every project on ${machineName} that use ${providerName}`}</TooltipPopup>
    </Tooltip>
  );
  const arm = (scope: Scope) => () => props.onAutoResumeChange(scope, true);
  const disarm = (scope: Scope) => () => props.onAutoResumeChange(scope, false);
  const armAll = scoped(
    button(`Auto-resume all ${stoppedCount}`, "Could not turn on auto-resume", arm("all")),
  );
  const buttons = reachable
    ? [
        button("Resume", "Could not resume thread", () => props.onResumeNow("thread")),
        stoppedCount > 1
          ? scoped(
              button(`Resume all ${stoppedCount}`, "Could not resume threads", () =>
                props.onResumeNow("all"),
              ),
            )
          : null,
      ]
    : scheduled
      ? [
          button("Cancel auto-resume", "Could not cancel auto-resume", disarm("thread")),
          unarmed > 0
            ? armAll
            : scheduledCount > 1
              ? scoped(
                  button(
                    `Cancel for all ${scheduledCount}`,
                    "Could not cancel auto-resume",
                    disarm("all"),
                  ),
                )
              : null,
        ]
      : [
          button("Auto-resume", "Could not turn on auto-resume", arm("thread")),
          // With only this thread left to arm, "all" would do the same as "Auto-resume".
          unarmed >= 2 ? armAll : null,
        ];
  return <span className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">{buttons}</span>;
}
