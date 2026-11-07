import { type TimestampFormat } from "@t3tools/contracts/settings";
import { CloudIcon, CloudOffIcon } from "lucide-react";
import { useState } from "react";
import { formatShortTimestamp } from "../../timestampFormat";
import { InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type Scope = "thread" | "all";

type RecoveryProps = {
  runId: string;
  machineName: string;
  providerName: string;
  stoppedAt: string;
  /** The server reached the provider again, and this thread is not set to resume. */
  reachable: boolean;
  scheduled: boolean;
  /** Threads on this machine and provider that stopped on the outage, this one included. */
  stoppedCount: number;
  scheduledCount: number;
  timestampFormat: TimestampFormat;
  onAutoResumeChange: (scope: Scope, autoResume: boolean) => Promise<void>;
  onResumeNow: (scope: Scope) => Promise<void>;
};

export function connectionRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const { machineName, providerName, reachable, scheduled, stoppedCount, scheduledCount } = props;
  const stopped =
    stoppedCount > 1
      ? `${stoppedCount} threads stopped`
      : `Stopped ${formatShortTimestamp(props.stoppedAt, props.timestampFormat)}`;
  const actions = <RecoveryActions key={`${props.runId}:${reachable}`} {...props} />;
  if (reachable) {
    return {
      id: `connection-recovery:${props.runId}`,
      variant: "info",
      group: "environment",
      icon: <CloudIcon />,
      title: `${providerName} is reachable again`,
      description: stopped,
      actions,
      wrapActions: true,
    };
  }
  return {
    id: `connection-recovery:${props.runId}`,
    variant: "warning",
    group: "environment",
    icon: <CloudOffIcon />,
    title: `${machineName} can't reach ${providerName}`,
    description: scheduled
      ? scheduledCount > 1
        ? `${scheduledCount} threads resume when reachable`
        : "Resumes when reachable"
      : stopped,
    actions,
    wrapActions: true,
  };
}

function RecoveryActions(props: RecoveryProps) {
  const { reachable, scheduled, stoppedCount, scheduledCount } = props;
  const [pending, setPending] = useState<string | null>(null);
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
      {pending === label ? "Saving..." : label}
    </InlineButton>
  );
  const all = `all ${stoppedCount}`;
  const buttons = reachable
    ? [
        button("Resume", "Could not resume thread", () => props.onResumeNow("thread")),
        stoppedCount > 1
          ? button(`Resume ${all}`, "Could not resume threads", () => props.onResumeNow("all"))
          : null,
      ]
    : scheduled
      ? [
          button("Cancel auto-resume", "Could not cancel auto-resume", () =>
            props.onAutoResumeChange("thread", false),
          ),
          scheduledCount < stoppedCount
            ? button(`Resume ${all}`, "Could not turn on auto-resume", () =>
                props.onAutoResumeChange("all", true),
              )
            : null,
          scheduledCount > 1
            ? button(`Cancel all ${scheduledCount}`, "Could not cancel auto-resume", () =>
                props.onAutoResumeChange("all", false),
              )
            : null,
        ]
      : [
          button("Resume when reachable", "Could not turn on auto-resume", () =>
            props.onAutoResumeChange("thread", true),
          ),
          stoppedCount > 1
            ? button(`Resume ${all}`, "Could not turn on auto-resume", () =>
                props.onAutoResumeChange("all", true),
              )
            : null,
        ];
  return <span className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">{buttons}</span>;
}
