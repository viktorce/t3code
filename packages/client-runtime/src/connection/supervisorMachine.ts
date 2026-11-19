import { createEffectLogic, setupEffect } from "@xstate/effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Tracer from "effect/Tracer";
import { types } from "xstate";

import {
  type ConnectionAttemptError,
  type NetworkStatus,
  NO_REFUSED_ROUTES,
  type SupervisorConnectionState,
} from "./model.ts";

const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 300_000;
const SESSION_LOSS_RETRY_DELAY_MS = 250;
// Someone is approving this device on the host; check back soon rather than climbing the ladder.
const APPROVAL_PENDING_RETRY_DELAY_MS = 4_000;
// A request lives 10 minutes; past that nobody is approving, so a forgotten device backs off.
const APPROVAL_PENDING_FAST_RETRIES = 150;

export interface SupervisorIntent {
  readonly desired: boolean;
  readonly network: NetworkStatus;
}

export interface PendingRetryTrace {
  readonly previousAttempt: Tracer.Span;
  readonly failureCount: number;
  readonly delayMs: number;
  readonly reason: ConnectionAttemptError["reason"];
}

export interface TracedAttemptFailure {
  readonly error: ConnectionAttemptError;
  readonly attemptSpan: Option.Option<Tracer.Span>;
}

export type AttemptOutcome =
  | {
      readonly _tag: "Interrupted";
      readonly established: boolean;
      readonly stable: boolean;
      readonly resetRetry: boolean;
    }
  | {
      readonly _tag: "Failure";
      readonly established: boolean;
      readonly stable: boolean;
      readonly failure: TracedAttemptFailure;
    };

export interface AttemptInput {
  readonly attempt: number;
  readonly generation: number;
  readonly lastFailure: ConnectionAttemptError | null;
  readonly pendingRetry: Option.Option<PendingRetryTrace>;
  readonly ignoreOffline: boolean;
}

/** What the attempt left behind, read in the same step so the machine stays pure. */
export interface AttemptResult {
  // Transition functions see state input as possibly undefined, so the attempt echoes it.
  readonly input: AttemptInput;
  readonly outcome: AttemptOutcome;
  readonly failedProbe: boolean;
  readonly intent: SupervisorIntent;
  readonly random: number;
  readonly now: number;
}

export interface IntentReading {
  readonly retryRequested: boolean;
  readonly intent: SupervisorIntent;
}

export interface ParkInput {
  readonly state: SupervisorConnectionState;
  readonly clearLease: boolean;
}

function retryDelayMs(failureCount: number, random: number): number {
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (failureCount + 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}

export function availableState(
  intent: SupervisorIntent,
  generation: number,
): SupervisorConnectionState {
  return {
    desired: false,
    network: intent.network,
    phase: "available",
    stage: null,
    attempt: 0,
    generation,
    lastFailure: null,
    retryAt: null,
    refusedRouteIds: NO_REFUSED_ROUTES,
  };
}

export function offlineState(
  intent: SupervisorIntent,
  generation: number,
  attempt: number,
  lastFailure: ConnectionAttemptError | null,
): SupervisorConnectionState {
  return {
    desired: true,
    network: intent.network,
    phase: "offline",
    stage: null,
    attempt,
    generation,
    lastFailure,
    retryAt: null,
    refusedRouteIds: NO_REFUSED_ROUTES,
  };
}

export function connectingState(
  intent: SupervisorIntent,
  generation: number,
  attempt: number,
  lastFailure: ConnectionAttemptError | null,
  stage: SupervisorConnectionState["stage"] = "preparing",
): SupervisorConnectionState {
  return {
    desired: true,
    network: intent.network,
    phase: "connecting",
    stage,
    attempt,
    generation,
    lastFailure,
    retryAt: null,
    refusedRouteIds: NO_REFUSED_ROUTES,
  };
}

interface RetryLadder {
  readonly failureCount: number;
  // Approval waits count as attempts but not toward backoff, so a later outage starts low.
  readonly backoffFailures: number;
  readonly approvalWaits: number;
  readonly pendingRetry: Option.Option<PendingRetryTrace>;
}

interface RunContext extends RetryLadder {
  readonly generation: number;
  readonly latestFailure: ConnectionAttemptError | null;
  readonly replacing: boolean;
}

const FRESH_LADDER: RetryLadder = {
  failureCount: 0,
  backoffFailures: 0,
  approvalWaits: 0,
  pendingRetry: Option.none(),
};

const resetLadder = (context: RunContext): RunContext => ({ ...context, ...FRESH_LADDER });

const unprovided = (name: string) =>
  Effect.die(new Error(`EnvironmentSupervisor machine actor "${name}" was not provided`));

const readIntent = createEffectLogic<IntentReading>({ effect: unprovided("readIntent") });
const attempt = createEffectLogic<AttemptResult, never, AttemptInput>({
  effect: () => unprovided("attempt"),
});
// Publishes the state, then waits for a signal; true when it resets the backoff.
const park = createEffectLogic<boolean, never, ParkInput>({ effect: () => unprovided("park") });
const publish = createEffectLogic<void, never, SupervisorConnectionState>({
  effect: () => unprovided("publish"),
});

const parked = { schemas: { input: types<{ readonly state: SupervisorConnectionState }>() } };

/**
 * The supervisor's retry policy. Every effect lives in the actors that
 * `supervisor.ts` provides; the transitions only decide what runs next.
 */
export const supervisorMachine = setupEffect({
  schemas: { context: types<RunContext>() },
  states: {
    deciding: {},
    attempting: { schemas: { input: types<AttemptInput>() } },
    available: parked,
    offline: parked,
    blocked: parked,
    probeFailed: parked,
    backoff: {
      schemas: {
        input: types<{ readonly state: SupervisorConnectionState; readonly delayMs: number }>(),
      },
    },
  },
  actors: { readIntent, attempt, park, publish },
}).createMachine({
  id: "environmentSupervisor",
  context: { ...FRESH_LADDER, generation: 0, latestFailure: null, replacing: false },
  initial: "deciding",
  states: {
    deciding: {
      invoke: {
        id: "readIntent",
        src: "readIntent",
        onDone: ({ context, event }) => {
          const { retryRequested, intent } = event.output;
          const next = retryRequested ? { ...resetLadder(context), latestFailure: null } : context;
          if (!intent.desired) {
            const idle = { ...resetLadder(next), latestFailure: null };
            return {
              target: "available",
              context: idle,
              input: { state: availableState(intent, idle.generation) },
            };
          }
          // The platform's offline report can stay wrong after the network is back,
          // so an explicit retry still tries instead of waiting for it to change.
          const ignoreOffline = next.replacing || retryRequested;
          if (intent.network === "offline" && !ignoreOffline) {
            return {
              target: "offline",
              context: next,
              input: {
                state: offlineState(
                  intent,
                  next.generation,
                  next.failureCount + 1,
                  next.latestFailure,
                ),
              },
            };
          }
          return {
            target: "attempting",
            context: next,
            input: {
              attempt: next.failureCount + 1,
              generation: next.generation + 1,
              lastFailure: next.latestFailure,
              pendingRetry: next.pendingRetry,
              ignoreOffline,
            },
          };
        },
      },
    },
    available: {
      invoke: {
        id: "park",
        src: "park",
        input: ({ input }) => ({ state: input.state, clearLease: true }),
        onDone: { target: "deciding" },
      },
    },
    offline: {
      invoke: {
        id: "park",
        src: "park",
        input: ({ input }) => ({ state: input.state, clearLease: true }),
        onDone: ({ context, event }) => ({
          target: "deciding",
          context: event.output ? resetLadder(context) : context,
        }),
      },
    },
    blocked: {
      invoke: {
        id: "park",
        src: "park",
        input: ({ input }) => ({ state: input.state, clearLease: false }),
        onDone: ({ context, event }) => ({
          target: "deciding",
          context: event.output ? resetLadder(context) : context,
        }),
      },
    },
    probeFailed: {
      invoke: {
        id: "publish",
        src: "publish",
        input: ({ input }) => input.state,
        onDone: { target: "deciding" },
      },
    },
    backoff: {
      timeout: ({ input }) => input.delayMs,
      onTimeout: { target: "deciding" },
      invoke: {
        id: "park",
        src: "park",
        input: ({ input }) => ({ state: input.state, clearLease: false }),
        onDone: ({ context, event }) => ({
          target: "deciding",
          context: event.output ? resetLadder(context) : context,
        }),
      },
    },
    attempting: {
      invoke: {
        id: "attempt",
        src: "attempt",
        input: ({ input }) => input,
        onDone: ({ context, event }) => {
          const { input, outcome, failedProbe, intent, random, now } = event.output;
          let next: RunContext = { ...context, replacing: false };
          if (outcome.established) {
            // A session came up, so no earlier failure describes the connection.
            // Losing a live session is not a failed connection either, for example
            // a socket the OS killed while the app was suspended: its replacement
            // reports no failure until it fails itself.
            next = { ...next, generation: input.generation, latestFailure: null };
            if (outcome.stable) next = resetLadder(next);
          }
          if (outcome._tag === "Interrupted") {
            return {
              target: "deciding",
              context: outcome.resetRetry ? { ...resetLadder(next), replacing: true } : next,
            };
          }

          const { error, attemptSpan } = outcome.failure;
          if (!outcome.established) next = { ...next, latestFailure: error };
          if (error._tag === "ConnectionBlockedError") {
            return {
              target: "blocked",
              context: next,
              input: {
                state: {
                  desired: intent.desired,
                  network: intent.network,
                  phase: "blocked",
                  stage: null,
                  attempt: input.attempt,
                  generation: next.generation,
                  lastFailure: error,
                  retryAt: null,
                  refusedRouteIds: NO_REFUSED_ROUTES,
                },
              },
            };
          }
          if (failedProbe) {
            const reset = resetLadder(next);
            return {
              target: "probeFailed",
              context: reset,
              input: { state: connectingState(intent, reset.generation, 1, reset.latestFailure) },
            };
          }

          // The first loss of a live session retries almost at once; the ladder
          // still counts it, so a host that keeps dropping sessions backs off.
          const firstLoss = outcome.established && next.failureCount === 0;
          const failureCount = next.failureCount + 1;
          const approvalWaits = next.approvalWaits + (error.reason === "approval-pending" ? 1 : 0);
          const awaitingApproval =
            error.reason === "approval-pending" && approvalWaits <= APPROVAL_PENDING_FAST_RETRIES;
          const backoffFailures = next.backoffFailures + (awaitingApproval ? 0 : 1);
          const delayMs = awaitingApproval
            ? APPROVAL_PENDING_RETRY_DELAY_MS
            : firstLoss
              ? Math.round(SESSION_LOSS_RETRY_DELAY_MS * (0.5 + random / 2))
              : error.reason === "approval-pending"
                ? Math.max(
                    APPROVAL_PENDING_RETRY_DELAY_MS,
                    retryDelayMs(backoffFailures - 1, random),
                  )
                : retryDelayMs(backoffFailures - 1, random);
          return {
            target: "backoff",
            context: {
              ...next,
              failureCount,
              approvalWaits,
              backoffFailures,
              pendingRetry: Option.map(attemptSpan, (previousAttempt) => ({
                previousAttempt,
                failureCount,
                delayMs,
                reason: error.reason,
              })),
            },
            input: {
              delayMs,
              state: {
                desired: intent.desired,
                network: intent.network,
                phase: "backoff",
                stage: null,
                attempt: input.attempt,
                generation: next.generation,
                lastFailure: next.latestFailure,
                retryAt: now + delayMs,
                refusedRouteIds: NO_REFUSED_ROUTES,
              },
            },
          };
        },
      },
    },
  },
});
