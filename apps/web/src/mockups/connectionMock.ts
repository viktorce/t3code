// PROTOTYPE: stands in for auto-resume state the server would track. Not for merge.
import { useSyncExternalStore } from "react";

export interface ConnectionMockState {
  readonly online: boolean;
  /** The server reached the provider again; threads not set to auto-resume stay stopped. */
  readonly reachable: boolean;
  /** Thread ids scheduled to resume when the provider is reachable again. */
  readonly autoResume: Readonly<Record<string, true>>;
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

export function useConnectionMock(): ConnectionMockState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

(window as unknown as { __connMock: unknown }).__connMock = {
  get: () => state,
  set: (next: Partial<ConnectionMockState>) =>
    setConnectionMock((current) => ({ ...current, ...next })),
  reset: () => setConnectionMock(() => INITIAL),
};
