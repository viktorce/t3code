import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A message after /clear in a fork that has not run yet starts a fresh session",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await browser.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Earlier work", messages: ["first"] });
    await t3.open(thread);

    await screen.getByText("first fixture turn complete", { exact: false }).waitFor();
    await screen.getByRole("button", "Fork from this response").first().tap();
    await screen.getByRole("button", "Thread actions for Earlier work fork").waitFor();

    const composer = screen.getByTestId("composer-editor");
    await composer.tap();
    await composer.pressSequentially("/clear");
    await composer.press("Enter");
    await screen.getByText("Your next message starts a fresh session").waitFor();
    await composer.pressSequentially("Start over");
    await composer.press("Enter");

    const newSession = screen.getByText("New session");
    // Wait for the fresh session's reply or the refusal, so both commits capture a settled send.
    await screen
      .getByText("first fixture turn complete", { exact: false })
      .nth(1)
      .or(screen.getByText("A fresh session can't start", { exact: false }))
      .waitFor();
    await app.screenshot("after-send");
    await expect(newSession).toBeVisible();
  },
);
