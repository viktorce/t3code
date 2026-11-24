import { describe, expect, it } from "vite-plus/test";

import { extractFenceTitle } from "./markdownCodeFence.ts";

describe("extractFenceTitle", () => {
  it.each([
    ['title="Build step"', "Build step"],
    ["title='Build step'", "Build step"],
    ["filename=src/app.ts", "src/app.ts"],
    ["showLineNumbers src/app.ts", "src/app.ts"],
    ["showLineNumbers", null],
    [undefined, null],
  ])("reads %j as %j", (meta, title) => {
    expect(extractFenceTitle(meta)).toBe(title);
  });
});
