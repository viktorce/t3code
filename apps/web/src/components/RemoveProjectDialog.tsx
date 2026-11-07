import { projectRemovalFailureText } from "@t3tools/client-runtime/state/projects";
import type { WorktreeKeepWhen } from "@t3tools/contracts";
import { CircleAlertIcon, CircleStopIcon, FolderIcon, Trash2Icon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import {
  type FocusEvent,
  Fragment,
  type ReactNode,
  type UIEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import {
  deletesMoreWorktrees,
  type RemoveProjectBlocker,
  type RemoveProjectFailure,
  type RemoveProjectRequest,
  type WorktreeRule,
} from "./RemoveProjectDialog.logic";
import { PROJECT_CHECKOUTS_SECTION_ID } from "./settings/settingsScope";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button, InlineButton } from "./ui/button";
import { Kbd } from "./ui/kbd";
import { Spinner } from "./ui/spinner";

const ROW_ICON_CLASS = "mt-0.5 size-4 shrink-0";

// Longer than a reflexive second click or press of whatever opened the dialog.
const CONFIRM_DELAY_MS = 500;

// The terms of the "Keep worktrees with local changes" setting.
const KEEP_WHEN_TERMS: Record<WorktreeKeepWhen, string> = {
  "any-local-files": "uncommitted changes or ignored files",
  "uncommitted-changes": "uncommitted changes",
  "tracked-changes": "edited tracked files",
};

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function listOf(names: ReadonlyArray<string>) {
  return names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/** Machine names keep their own case; only "this machine" opens a sentence in lower case. */
function sentence(text: string) {
  return text.startsWith("this machine") ? `T${text.slice(1)}` : text;
}

// Where single checkouts are removed; it links to this project's Checkouts section there.
const SETTINGS_PLACE = "Settings → Projects";

interface SettingsLink {
  readonly projectKey: string;
  /** Runs as the link is followed, to close what covers the page it opens. */
  readonly onFollow: () => void;
}

/**
 * The link moves between the hint and the amber line as machines connect. One that goes while
 * focused hands focus to the dialog first, or it would fall to the page, where the shortcut
 * reaches the browser. React runs the cleanup before it removes the node.
 */
function keepFocusInDialog(wrapper: HTMLElement | null) {
  if (!wrapper) return;
  return () => {
    if (!wrapper.contains(document.activeElement)) return;
    wrapper.closest<HTMLElement>("[data-slot=alert-dialog-popup]")?.focus();
  };
}

function withSettingsLink(text: string, link: SettingsLink | null, pending: boolean): ReactNode {
  const at = text.indexOf(SETTINGS_PLACE);
  if (at < 0 || link === null || pending) return text;
  const rest = text.slice(at + SETTINGS_PLACE.length);
  // The punctuation after the link stays on its line.
  const glued = /^[.,;:!?]*/.exec(rest)?.[0] ?? "";
  return (
    <>
      {text.slice(0, at)}
      {/* Keyed so React removes it whole, never reusing it for another span. */}
      <span key="settings-link" ref={keepFocusInDialog} className="whitespace-nowrap">
        <InlineButton
          render={
            <Link
              to="/settings/projects"
              search={{ project: link.projectKey, machine: undefined }}
              hash={PROJECT_CHECKOUTS_SECTION_ID}
            />
          }
          onClick={(event) => {
            // The router follows only a plain click; on others the browser opens a tab or
            // nothing, so the dialog stays.
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
            if (event.altKey) return;
            link.onFollow();
          }}
        >
          {SETTINGS_PLACE}
        </InlineButton>
        {glued}
      </span>
      {rest.slice(glued.length)}
    </>
  );
}

function blockerMessage(blocker: RemoveProjectBlocker, checkoutCount: number) {
  const machines = listOf(blocker.machines);
  const one = blocker.machines.length === 1;
  if (blocker.reason === "loading")
    return sentence(`${machines} ${one ? "is" : "are"} still loading…`);
  if (blocker.reason === "denied") return `This connection can't change projects on ${machines}.`;
  return sentence(
    `${machines} ${one ? "isn't" : "aren't"} connected. Connect ${one ? "it" : "them"} to remove ${
      checkoutCount > 1 && blocker.someRemovable
        ? `every checkout, or remove single checkouts in ${SETTINGS_PLACE}`
        : "this project"
    }.`,
  );
}

// The fade at a scroller's edge, as tall as what is left to scroll that way, up to this.
const EDGE_FADE_PX = 24;

/** Fades a scroller's edges by how far it can still move each way; true if it can move at all. */
function measureOverflow(element: HTMLElement) {
  const overflow = element.scrollHeight - element.clientHeight;
  // A scroller with room for barely a line fades less, so the fades don't cover it.
  const most = Math.min(EDGE_FADE_PX, element.clientHeight / 4);
  const fade = (distance: number) => `calc(100% - ${Math.min(most, Math.max(0, distance))}px)`;
  element.style.setProperty("--fade-top", fade(element.scrollTop));
  element.style.setProperty("--fade-bottom", fade(overflow - element.scrollTop));
  // What scrolls into view, or takes focus, stops clear of the fades.
  element.style.scrollPaddingBlock = `${most}px`;
  return overflow > 1;
}

/** A name that may wrap can also break after "/", so "owner/" and "repo" stay whole. */
function BreakableName(props: { readonly name: string }) {
  const parts = props.name.split(/(?<=\/)/);
  return parts.map((part, index) => (
    // oxlint-disable-next-line react/no-array-index-key -- the parts of one fixed string
    <Fragment key={index}>
      {part}
      {index < parts.length - 1 ? <wbr /> : null}
    </Fragment>
  ));
}

/**
 * A scroller takes keyboard focus while it scrolls, since not every browser makes one reachable, and
 * keeps its focus stop while focused, or focus would drop to the page, where the shortcut reaches the
 * browser. Unnamed: a name would drop its text from the dialog's description.
 */
function useScrollerFocus(onMeasure?: (element: HTMLElement) => void) {
  const [scrolls, setScrolls] = useState(false);
  const [focused, setFocused] = useState(false);
  return {
    // Contents can grow while the box keeps its height, so both are watched.
    ref: (element: HTMLElement | null) => {
      if (!element) return;
      return observeResize([element, ...element.children], () => {
        setScrolls(measureOverflow(element));
        onMeasure?.(element);
      });
    },
    onScroll: (event: UIEvent<HTMLElement>) => {
      measureOverflow(event.currentTarget);
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      if (event.target === event.currentTarget) setFocused(true);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (event.target === event.currentTarget) setFocused(false);
    },
    ...(scrolls || focused ? { tabIndex: 0 } : {}),
  };
}

/** What opening the dialog or pressing Remove accepts: each checkout's rule, and the threads. */
function acceptedOf(request: RemoveProjectRequest) {
  return {
    rules: new Map(request.checkouts.map((checkout) => [checkout.key, checkout.worktreeRule])),
    running: request.runningThreads.map((thread) => thread.key),
    threads: new Set(request.threadKeys),
    threadCounts: new Map(
      request.checkouts.map((checkout) => [checkout.key, checkout.threadCount]),
    ),
  };
}

// Below this much room, the effects stop scrolling on their own and the whole body scrolls.
const CRAMPED_EFFECTS_PX = 48;

/** What grew since Remove was last accepted. */
interface Changes {
  readonly joined: ReadonlyArray<string>;
  /**
   * How many more threads the checkouts have. A thread that arrived running moves from "stops" to
   * "deletes" when it finishes, which doesn't change this, so it isn't news twice.
   */
  readonly grown: number;
  /** Checkouts whose worktree rule now deletes more, with that rule. */
  readonly rules: ReadonlyMap<string, WorktreeRule>;
  /** Threads that started running. */
  readonly running: ReadonlyArray<string>;
}

/** Whether `after` calls out something `before` didn't; a change that only narrows is not news. */
function addsTo(before: Changes, after: Changes) {
  return (
    after.joined.some((key) => !before.joined.includes(key)) ||
    after.grown > before.grown ||
    after.running.some((key) => !before.running.includes(key)) ||
    [...after.rules].some(([key, rule]) => {
      const was = before.rules.get(key);
      return was === undefined || deletesMoreWorktrees(was, rule);
    })
  );
}

// The changes' key while nothing has changed since Remove was last accepted.
const UNCHANGED = "\t\t\t";

/** Wraps a long path only after a separator; a segment breaks inside only if it is wider than the line. */
function BreakablePath(props: { readonly path: string }) {
  const parts = props.path.split(/(?<=[/\\])/);
  return parts.map((part, index) => (
    // oxlint-disable-next-line react/no-array-index-key -- the parts of one fixed string
    <Fragment key={index}>
      <span className="inline-block max-w-full wrap-anywhere">{part}</span>
      {index < parts.length - 1 ? <wbr /> : null}
    </Fragment>
  ));
}

/**
 * Confirms removing a project, every checkout at once; the caller keeps `request` fixed while
 * `pending`. Cancel takes focus so a reflexive Enter keeps everything. Remove pauses, dimmed, for
 * half a second after opening, when a wait ends, and when more would go: a checkout joins, a thread
 * arrives, a worktree rule deletes more, or a thread starts running.
 */
export function RemoveProjectDialog(props: {
  readonly request: RemoveProjectRequest | null;
  readonly blockedBy: RemoveProjectBlocker | null;
  readonly pending: boolean;
  readonly failure: RemoveProjectFailure | null;
  readonly confirmShortcutLabel: string | null;
  readonly confirmAriaKeyShortcuts: string | null;
  readonly isConfirmShortcut: (event: KeyboardEvent) => boolean;
  /** This project's settings page, where single checkouts are removed; null where it can't open. */
  readonly settingsLink: SettingsLink | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { request, blockedBy } = props;
  const checkoutCount = request?.checkouts.length ?? 0;
  // What was last accepted, on opening or pressing Remove. A checkout that joins, a thread that
  // arrives, a rule that now deletes more, or a thread that starts running is called out. Changes
  // that delete less update quietly.
  const [accepted, setAccepted] = useState<ReturnType<typeof acceptedOf> | null>(null);
  const shown = request?.checkouts ?? [];
  const joined = accepted ? shown.filter((checkout) => !accepted.rules.has(checkout.key)) : [];
  const deletingMore = shown.filter((checkout) => {
    const before = accepted?.rules.get(checkout.key);
    return before !== undefined && deletesMoreWorktrees(before, checkout.worktreeRule);
  });
  const newlyRunning = accepted
    ? (request?.runningThreads ?? []).filter((thread) => !accepted.running.includes(thread.key))
    : [];
  // Per checkout, so what a failed try takes with its checkout, a list that hasn't caught up, and
  // older threads the list loads aren't news. A thread gone from one checkout doesn't offset one that
  // arrived on another: summed across them, a lagging list's fall would hide real arrivals.
  const grown = accepted
    ? shown.reduce(
        (sum, checkout) =>
          sum + Math.max(0, checkout.threadCount - (accepted.threadCounts.get(checkout.key) ?? 0)),
        0,
      )
    : 0;
  // A thread that arrived running is named once, as one that stops.
  const moreThreads = Math.max(
    0,
    grown - newlyRunning.filter((thread) => !accepted?.threads.has(thread.key)).length,
  );
  // What changed since then, or null while Remove waits.
  const changes: Changes | null =
    blockedBy === null
      ? {
          joined: joined.map((checkout) => checkout.key),
          grown,
          rules: new Map(deletingMore.map((checkout) => [checkout.key, checkout.worktreeRule])),
          running: newlyRunning.map((thread) => thread.key),
        }
      : null;
  const changesKey =
    changes &&
    [
      changes.joined.join("\n"),
      changes.grown > 0 ? `+${changes.grown}` : "",
      [...changes.rules].map(([key, rule]) => `${key}=${rule}`).join("\n"),
      changes.running.join("\n"),
    ].join("\t");
  const [last, setLast] = useState({ key: changesKey, changes });
  // The pause underway and what it is for; each pause is a new object, so its timer starts over.
  const [holdingFor, setHoldingFor] = useState<{ readonly key: string } | null>(null);
  const closingLineId = useId();
  if ((request === null) !== (accepted === null)) {
    setAccepted(request === null ? null : acceptedOf(request));
    // Opening pauses Remove too, so a second press of whatever opened the dialog lands on nothing.
    setHoldingFor(request === null || changesKey === null ? null : { key: changesKey });
  }
  const failedAttempt = props.failure?.attempt ?? null;
  if (changesKey !== last.key) {
    setLast({ key: changesKey, changes });
    // Opening is handled above, and pressing Remove accepts what is shown. A wait that ends, or a
    // change that adds to what is called out, pauses Remove; one that only narrows leaves it be.
    if (request !== null && accepted !== null) {
      if (changesKey === null || (changesKey === UNCHANGED && last.key !== null)) {
        setHoldingFor(null);
      } else if (last.changes === null || (changes !== null && addsTo(last.changes, changes))) {
        setHoldingFor({ key: changesKey });
      }
    }
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Remove resumes once the summary has held still
  useEffect(() => {
    if (holdingFor === null) return;
    const timer = window.setTimeout(() => setHoldingFor(null), CONFIRM_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [holdingFor]);
  const holding = holdingFor !== null;
  const effectsScroller = useScrollerFocus();
  // A window too short for the lines below the effects plus two lines of them scrolls the whole
  // body, so the effects never shrink to a sliver. The same sum decides both ways, so it can't flip.
  const [cramped, setCramped] = useState(false);
  const bodyScroller = useScrollerFocus((body) => {
    const effects = body.firstElementChild;
    if (!(effects instanceof HTMLElement)) return;
    setCramped(body.clientHeight - (body.scrollHeight - effects.offsetHeight) < CRAMPED_EFFECTS_PX);
  });
  // With more room the error and the closing line sit below the effects and always show. Once the
  // whole body scrolls, they can be below the fold: when they appear, and when what appeared is what
  // made the body scroll. Before paint, so nothing flashes out of view.
  const failureRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a new error must be seen
  useLayoutEffect(() => {
    if (cramped && failedAttempt !== null) failureRef.current?.scrollIntoView({ block: "nearest" });
  }, [cramped, failedAttempt]);
  const notice = holdingFor !== null && holdingFor.key !== UNCHANGED ? holdingFor : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a change in what goes must be seen
  useLayoutEffect(() => {
    if (cramped && notice !== null) {
      document.getElementById(closingLineId)?.scrollIntoView({ block: "nearest" });
    }
  }, [cramped, notice, closingLineId]);
  const scope = checkoutCount === 2 ? "both checkouts" : `all ${checkoutCount} checkouts`;
  const canConfirm = !props.pending && blockedBy === null;
  const worktrees = request?.worktreeDeletion ?? null;
  const exceptKept = worktrees ? `except ones with ${KEEP_WHEN_TERMS[worktrees.keepWhen]}` : "";
  const folders =
    checkoutCount === 1
      ? "the project folder"
      : checkoutCount === 2
        ? "both folders"
        : `all ${checkoutCount} folders`;
  const scopeWord = request?.worktreeNames === "folder" ? "of" : "on";
  // Cancel is disabled while removing, so focus moves to the popup, which keeps swallowing the chord.
  const confirm = () => {
    if (!canConfirm || holding) {
      // A short window can scroll away the line that says why Remove waits or what changed. The
      // pause on opening or after a wait, and a removal underway, leave that line with nothing new.
      if (blockedBy !== null || notice !== null) {
        document.getElementById(closingLineId)?.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    popupRef.current?.focus();
    if (request) setAccepted(acceptedOf(request));
    props.onConfirm();
  };
  const blockerText = blockedBy ? blockerMessage(blockedBy, checkoutCount) : null;
  // While Remove waits, the line below the error says why and what to do, so the error doesn't.
  const failureText = props.failure
    ? projectRemovalFailureText(props.failure, {
        cause:
          props.failure.cause !== null && (blockerText?.startsWith(props.failure.cause) ?? false),
        advice: blockerText !== null,
      })
    : "";
  // An empty project's only possible losses fit one hedged line.
  const foldsWorktrees =
    request?.threadCount === 0 && worktrees?.certainty === "possible" && worktrees.only === null;
  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !props.pending) props.onCancel();
      }}
    >
      <AlertDialogPopup
        ref={popupRef}
        // A focused Cancel would show its focus ring at rest on touch screens, where Enter is moot.
        initialFocus={() =>
          window.matchMedia("(pointer: coarse)").matches ? popupRef.current : cancelRef.current
        }
        onKeyDown={(event) => {
          if (!props.isConfirmShortcut(event.nativeEvent)) return;
          // Repeats are swallowed too, or a held chord would reach the browser's own binding.
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) confirm();
        }}
      >
        {request ? (
          <>
            {/* The body is a left-aligned list, so the title stays left on phones too. */}
            <AlertDialogHeader className="text-left">
              {/* "T3 Code" stays whole, and so does a name that fits beside "Remove": up to 22
                  characters on phones, 34 wider. A longer one wraps like the rest. */}
              <AlertDialogTitle>
                <span className="block text-balance">
                  Remove{" "}
                  <span
                    className={cn(
                      request.name.length <= 22
                        ? "inline-block max-w-full"
                        : request.name.length <= 34 && "sm:inline-block sm:max-w-full",
                    )}
                  >
                    "
                    {request.name.length <= 22 ? (
                      request.name
                    ) : (
                      <BreakableName name={request.name} />
                    )}
                    "
                  </span>{" "}
                  from T3{" "}Code?
                </span>
              </AlertDialogTitle>
              {/* The effects scroll, so the lines below them stay in view. Their 4px inset, taken
                  back by the margin here, gives the focus rings room. */}
              <AlertDialogDescription render={<div />} className="-mx-1 flex flex-col">
                <div
                  {...bodyScroller}
                  className={cn(
                    "flex min-h-0 flex-col rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    cramped &&
                      "overflow-y-auto overscroll-contain mask-t-from-(--fade-top) mask-b-from-(--fade-bottom) focus-visible:mask-none",
                  )}
                >
                  <div
                    {...effectsScroller}
                    className={cn(
                      "rounded-sm p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      cramped
                        ? "shrink-0"
                        : "min-h-0 overflow-y-auto overscroll-contain mask-t-from-(--fade-top) mask-b-from-(--fade-bottom) focus-visible:mask-none",
                    )}
                  >
                    <ul className="flex flex-col gap-3 text-left text-pretty">
                      {/* Red marks what is certain to go; a muted icon marks what may not exist. */}
                      <li className="flex gap-2.5">
                        <Trash2Icon
                          aria-hidden
                          className={cn(
                            ROW_ICON_CLASS,
                            request.threadCount > 0 && "text-destructive",
                          )}
                        />
                        {/* Clients hold no archived threads, so the count leaves them out. */}
                        <span className="text-foreground">
                          {request.threadCount > 0
                            ? `Deletes ${plural(request.threadCount, "thread")} and any archived ones`
                            : foldsWorktrees
                              ? // Two sentences, so the exception can't be read as sparing threads.
                                `Deletes any archived threads. Deletes their worktrees, ${exceptKept}.`
                              : "Deletes any archived threads"}
                        </span>
                      </li>
                      {request.runningThreads.length > 0 ? (
                        <li className="flex gap-2.5">
                          <CircleStopIcon
                            aria-hidden
                            className={cn(ROW_ICON_CLASS, "text-warning-foreground")}
                          />
                          <span className="text-foreground">
                            {/* "Unfinished" also covers a thread waiting on an approval. */}
                            {request.runningThreads.length === 1
                              ? `Stops "${request.runningThreads[0]!.title}", which hasn't finished`
                              : `Stops ${request.runningThreads.length} unfinished threads`}
                          </span>
                        </li>
                      ) : null}
                      {worktrees && !foldsWorktrees ? (
                        <li className="flex gap-2.5">
                          <Trash2Icon
                            aria-hidden
                            className={cn(
                              ROW_ICON_CLASS,
                              worktrees.certainty === "known" && "text-destructive",
                            )}
                          />
                          <span className="text-foreground">
                            Deletes thread worktrees
                            {worktrees.only ? ` ${scopeWord} ${listOf(worktrees.only)}` : ""}
                            {worktrees.certainty === "possible" ? ", if any" : ""}, {exceptKept}
                          </span>
                        </li>
                      ) : null}
                      <li className="flex gap-2.5">
                        <FolderIcon aria-hidden className={ROW_ICON_CLASS} />
                        <span className="flex min-w-0 flex-col gap-1">
                          {/* "Folders" for what stays on disk, "checkouts" for the entries that go. */}
                          <span className="text-foreground">
                            {request.keptWorktrees.length === 0
                              ? `Keeps ${folders} and provider sessions on disk`
                              : // "Its" or "their" would cover a checkout whose rule isn't known.
                                worktrees ||
                                  request.checkouts.some(
                                    (checkout) => checkout.worktreeRule === "unknown",
                                  )
                                ? `Keeps ${folders}, the thread worktrees ${scopeWord} ${listOf(request.keptWorktrees)}, and provider sessions on disk`
                                : `Keeps ${folders}, ${checkoutCount === 1 ? "its" : "their"} thread worktrees, and provider sessions on disk`}
                          </span>
                          <span className="flex flex-col gap-1">
                            {request.checkouts.map((checkout) => (
                              <span key={checkout.key} className="text-xs">
                                {checkout.location} ·{" "}
                                <BreakablePath path={checkout.workspaceRoot} />
                              </span>
                            ))}
                          </span>
                          {/* While a machine is offline the amber line below gives this advice, and with
                            no machine that takes changes, Settings can't remove a checkout either. */}
                          {checkoutCount > 1 &&
                          (blockedBy === null ||
                            (blockedBy.reason !== "offline" && blockedBy.someRemovable)) ? (
                            <span className="mt-1.5 text-xs">
                              {withSettingsLink(
                                `To remove just one checkout, use ${SETTINGS_PLACE}.`,
                                props.settingsLink,
                                props.pending,
                              )}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    </ul>
                  </div>
                  {props.failure ? (
                    // What happened sits before what to do, which stays next to the buttons. The last
                    // try's error stays, dimmed, while the next runs, so nothing jumps.
                    <div
                      key={props.failure.attempt}
                      ref={failureRef}
                      className={cn("mt-3 shrink-0 px-1", props.pending && "opacity-60")}
                    >
                      <Alert variant="error" controlAlignment="first-line">
                        <CircleAlertIcon aria-hidden />
                        <AlertTitle>{props.failure.title}</AlertTitle>
                        {failureText ? <AlertDescription>{failureText}</AlertDescription> : null}
                      </Alert>
                    </div>
                  ) : null}
                  {/* Announces when a machine connects, loads, or drops, or a checkout joins. */}
                  <p
                    id={closingLineId}
                    aria-live="polite"
                    className={cn(
                      "mt-3 shrink-0 px-1 text-left",
                      (blockedBy?.reason === "offline" || blockedBy?.reason === "denied") &&
                        "text-warning-foreground",
                    )}
                  >
                    {blockerText !== null ? (
                      withSettingsLink(blockerText, props.settingsLink, props.pending)
                    ) : (
                      <>
                        {joined.length > 0 && checkoutCount > 1 ? (
                          <span className="text-foreground">Now removes {scope}. </span>
                        ) : null}
                        {moreThreads > 0 ? (
                          <span className="text-foreground">
                            Now deletes {plural(moreThreads, "more thread")}.{" "}
                          </span>
                        ) : null}
                        {deletingMore.length > 0 ? (
                          <span className="text-foreground">
                            {deletingMore.some((checkout) => {
                              const before = accepted?.rules.get(checkout.key);
                              return before === "keep" || before === "unknown";
                            })
                              ? `Now deletes thread worktrees ${scopeWord} `
                              : `Now deletes more thread worktrees ${scopeWord} `}
                            {listOf([
                              ...new Set(deletingMore.map((checkout) => checkout.worktreeName)),
                            ])}
                            {worktrees?.certainty === "possible" ? ", if any" : ""}.{" "}
                          </span>
                        ) : null}
                        {newlyRunning.length > 0 ? (
                          <span className="text-foreground">
                            {newlyRunning.length === 1
                              ? `Now stops "${newlyRunning[0]!.title}". `
                              : `Now stops ${newlyRunning.length} more unfinished threads. `}
                          </span>
                        ) : null}
                        <span className="whitespace-nowrap">This can't be undone.</span>
                        {props.confirmShortcutLabel ? (
                          <>
                            {" "}
                            {/* The remove button carries the shortcut for assistive technology. */}
                            <span
                              aria-hidden
                              className={cn(
                                "whitespace-nowrap pointer-coarse:hidden",
                                props.pending && "invisible",
                              )}
                            >
                              Press <Kbd>{props.confirmShortcutLabel}</Kbd> to remove.
                            </span>
                          </>
                        ) : null}
                      </>
                    )}
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            {/* The desktop app's smallest window needs the height for the summary. */}
            <AlertDialogFooter stacking="touch">
              <span role="status" className="sr-only">
                {props.pending ? `Removing ${request.name}` : ""}
              </span>
              <AlertDialogClose
                ref={cancelRef}
                render={<Button variant="outline" />}
                disabled={props.pending}
              >
                Cancel
              </AlertDialogClose>
              <Button
                variant="destructive"
                // Unlike disabled, keeps focus on the button while it can't run, so the shortcut
                // never reaches the browser from the page.
                aria-disabled={!canConfirm || holding || undefined}
                // The closing line says why Remove waits, or that it can't be undone.
                aria-describedby={closingLineId}
                onClick={confirm}
                {...(props.confirmAriaKeyShortcuts
                  ? { "aria-keyshortcuts": props.confirmAriaKeyShortcuts }
                  : {})}
              >
                {/* Both states share one cell, so the button, and Cancel beside it, keep their width. */}
                <span className="grid justify-items-center">
                  <span
                    className={cn(
                      "col-start-1 row-start-1 inline-flex items-center gap-2",
                      props.pending && "invisible",
                    )}
                  >
                    <Trash2Icon aria-hidden />
                    {checkoutCount === 1 ? "Remove project" : `Remove ${scope}`}
                  </span>
                  <span
                    aria-hidden={!props.pending}
                    className={cn(
                      "col-start-1 row-start-1 inline-flex items-center gap-2",
                      !props.pending && "invisible",
                    )}
                  >
                    <Spinner aria-hidden />
                    Removing…
                  </span>
                </span>
              </Button>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogPopup>
    </AlertDialog>
  );
}
