import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  chunkTerminalWrite,
  DEFAULT_TERMINAL_ID,
  TERMINAL_WRITE_MAX_LENGTH,
  TerminalError,
  TerminalOpenInput,
  TerminalProviderEnvironmentError,
  unfinishedTerminalSequence,
} from "./terminal.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const encodeTerminalError = Schema.encodeUnknownSync(TerminalError);
const decodeTerminalError = Schema.decodeUnknownSync(TerminalError);

function decodeSync<S extends Schema.Top>(schema: S, input: unknown): Schema.Schema.Type<S> {
  return Schema.decodeUnknownSync(schema as never)(input) as Schema.Schema.Type<S>;
}

describe("TerminalProviderEnvironmentError", () => {
  it("round-trips its required cause without exposing it in the message", () => {
    const cause = { operation: "read-secret", detail: "secret backend unavailable" };
    const error = new TerminalProviderEnvironmentError({
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      cause,
    });
    const encoded = encodeTerminalError(error);
    const decoded = decodeTerminalError(encoded);

    expect(decoded).toMatchObject({
      _tag: "TerminalProviderEnvironmentError",
      providerInstanceId: "codex_work",
      cause,
    });
    expect(decoded.message).toBe(
      "Could not prepare the terminal environment for provider instance: codex_work",
    );
    expect(decoded.message).not.toContain("secret backend unavailable");
  });
});

describe("TerminalOpenInput", () => {
  it("drops invalid env keys while retaining valid overrides", () => {
    const parsed = decodeSync(TerminalOpenInput, {
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      cwd: "/tmp/project",
      env: { "bad-key": "1", GOOD_KEY: "2" },
    });
    expect(parsed.env).toEqual({ GOOD_KEY: "2" });
  });
});

describe("chunkTerminalWrite", () => {
  it("splits oversized writes so every chunk fits the contract", () => {
    const chunks = chunkTerminalWrite("y".repeat(TERMINAL_WRITE_MAX_LENGTH * 2 + 5));
    expect(chunks.map((chunk) => chunk.length)).toEqual([
      TERMINAL_WRITE_MAX_LENGTH,
      TERMINAL_WRITE_MAX_LENGTH,
      5,
    ]);
    expect(chunks.join("")).toHaveLength(TERMINAL_WRITE_MAX_LENGTH * 2 + 5);
  });

  it("does not cut a surrogate pair in half at the boundary", () => {
    const data = `${"z".repeat(TERMINAL_WRITE_MAX_LENGTH - 1)}😀tail`;
    const chunks = chunkTerminalWrite(data);
    expect(chunks[0]).toHaveLength(TERMINAL_WRITE_MAX_LENGTH - 1);
    expect(chunks[1]).toBe("😀tail");
    expect(chunks.join("")).toBe(data);
  });
});

describe("unfinishedTerminalSequence", () => {
  it.each([
    { name: "a query after a finished colour change", text: "a\x1b[31mb\x1b[6", open: "\x1b[6" },
    { name: "text after a finished sequence", text: "a\x1b[31mb", open: "" },
    { name: "text with no ESC", text: "]abc", open: "" },
    { name: "an ESC alone", text: "ab\x1b", open: "\x1b" },
    // A terminal runs these controls when they arrive, so they are not sent again.
    { name: "a CSI holding a space and a line feed", text: "\x1b[2 \n", open: "\x1b[2 " },
    { name: "an escape holding a tab and a backspace", text: "\x1b\t(\b", open: "\x1b(" },
    { name: "a title string holding a line feed", text: "\x1b]0;a\nb", open: "\x1b]0;a\nb" },
    { name: "an ended title string", text: "\x1b]0;a\x07", open: "" },
  ])("returns the open sequence after $name", ({ text, open }) => {
    expect(unfinishedTerminalSequence(text)).toBe(open);
  });
});
