import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import { initialTransition, transition } from "xstate";

import { ConnectionTransientError } from "./model.ts";
import { type AttemptResult, supervisorMachine } from "./supervisorMachine.ts";

type Snapshot = ReturnType<typeof initialTransition<typeof supervisorMachine>>[0];

const intent = { desired: true, network: "online" } as const;
const pending = new ConnectionTransientError({
  reason: "approval-pending",
  detail: "Approve this device on Mac mini.",
});

// `transition` types events from schemas.events, which has no lifecycle events.
const finish = (snapshot: Snapshot, actorId: string, output: unknown) => {
  const done = { type: "xstate.done.actor", actorId, output };
  return transition(supervisorMachine, snapshot, done)[0];
};

const failAttempt = (snapshot: Snapshot): Snapshot => {
  const attempt = snapshot.getInputs()["environmentSupervisor.attempting"];
  const result: AttemptResult = {
    input: attempt,
    outcome: {
      _tag: "Failure",
      established: false,
      stable: false,
      failure: { error: pending, attemptSpan: Option.none() },
    },
    failedProbe: false,
    intent,
    random: 1,
    now: 0,
  };
  return finish(snapshot, "attempt", result);
};

describe("supervisorMachine", () => {
  it("backs off a device nobody approved once its request has expired", () => {
    let [snapshot] = initialTransition(supervisorMachine);
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 156; attempt++) {
      snapshot = finish(snapshot, "readIntent", { retryRequested: false, intent });
      snapshot = failAttempt(snapshot);
      expect(snapshot.value).toBe("backoff");
      delays.push(snapshot.getInputs()["environmentSupervisor.backoff"].delayMs);
      snapshot = finish(snapshot, "park", false);
    }
    expect(delays.slice(0, 150).every((delay) => delay === 4_000)).toBe(true);
    expect(delays.slice(150)).toEqual([4_000, 4_000, 8_000, 16_000, 32_000, 64_000]);
  });
});
