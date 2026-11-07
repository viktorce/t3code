// PROTOTYPE: stands in for auto-resume state the server would track. Not for merge.
import { useSyncExternalStore } from "react";

export interface ConnectionMockState {
  readonly online: boolean;
  /** The server reached the provider again; threads not set to auto-resume stay stopped. */
  readonly reachable: boolean;
  /** Thread ids scheduled to resume when the provider is reachable again. */
  readonly autoResume: Readonly<Record<string, true>>;
  /** Thread ids whose auto-resume gave up after its last allowed attempt. */
  readonly gaveUp: Readonly<Record<string, true>>;
  /** Messages sent during the outage, held until the thread resumes. */
  readonly held: Readonly<
    Record<string, ReadonlyArray<{ readonly id: string; readonly text: string }>>
  >;
  /** Thread ids resumed after the connection came back. */
  readonly resumed: Readonly<Record<string, true>>;
  readonly checkedAt: string | null;
  readonly autoResumeSetting: boolean;
}

const KEY = "mock:connection-recovery";
const INITIAL: ConnectionMockState = {
  online: false,
  reachable: false,
  autoResume: {},
  gaveUp: {},
  held: {},
  resumed: {},
  checkedAt: null,
  autoResumeSetting: false,
};

function load(): ConnectionMockState {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...INITIAL, ...JSON.parse(raw) } : INITIAL;
  } catch {
    return INITIAL;
  }
}

let state = load();
const listeners = new Set<() => void>();

export function setConnectionMock(update: (current: ConnectionMockState) => ConnectionMockState) {
  state = update(state);
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Prototype only.
  }
  for (const listener of listeners) listener();
}

export function getConnectionMock(): ConnectionMockState {
  return state;
}

export function useConnectionMock(): ConnectionMockState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

// Drives the prototype's states from the console; tests run without a window.
if (typeof window !== "undefined") {
  (window as unknown as { __connMock: unknown }).__connMock = {
    get: () => state,
    set: (next: Partial<ConnectionMockState>) =>
      setConnectionMock((current) => ({ ...current, ...next })),
    reset: () => setConnectionMock(() => INITIAL),
  };
}
