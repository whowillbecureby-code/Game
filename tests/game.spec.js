const { test, expect } = require("@playwright/test");

test("lobby validates required player and room names", async ({ page }) => {
  await page.goto("/");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "방 만들기" }).click();
  await expect(page.locator("#message")).toContainText("이름과 방 이름을 입력해 줘.");
});

test("two players can join a room and the host can start a match", async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();

  try {
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    await host.goto("/");
    await host.locator("#playerName").fill("PlaywrightHost");
    await host.locator("#roomName").fill("pw-room-smoke");
    await host.getByRole("button", { name: "방 만들기" }).click();

    await expect(host.locator("#message")).toHaveText("방 참가 완료!");
    await expect(host.locator("#start")).toBeVisible();

    await guest.goto("/");
    await guest.locator("#playerName").fill("PlaywrightGuest");
    await guest.locator("#roomName").fill("pw-room-smoke");
    await guest.getByRole("button", { name: "방 참가" }).click();

    await expect(guest.locator("#message")).toHaveText("방 참가 완료!");
    await expect(host.locator("#waiting")).toContainText("PlaywrightGuest");

    await host.locator("#start").click();

    await expect(host.locator("#battle")).toBeVisible();
    await expect(guest.locator("#battle")).toBeVisible();
    await expect(host.locator("#turnText")).toContainText("PlaywrightHost");
    await expect(host.locator("#hand .card")).toHaveCount(3);
    await expect(guest.locator("#hand .card")).toHaveCount(3);
    await expect(host.locator("#hand .card").first()).toBeEnabled();
    await expect(guest.locator("#hand .card").first()).toBeDisabled();
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

test("the next player becomes host and can start after the original host leaves", async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const thirdContext = await browser.newContext();

  try {
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const third = await thirdContext.newPage();

    await host.goto("/");
    await host.locator("#playerName").fill("LeavingHost");
    await host.locator("#roomName").fill("pw-host-handoff");
    await host.getByRole("button", { name: "방 만들기" }).click();
    await expect(host.locator("#message")).toHaveText("방 참가 완료!");

    await guest.goto("/");
    await guest.locator("#playerName").fill("NewHost");
    await guest.locator("#roomName").fill("pw-host-handoff");
    await guest.getByRole("button", { name: "방 참가" }).click();
    await expect(guest.locator("#message")).toHaveText("방 참가 완료!");
    await expect(guest.locator("#start")).toBeHidden();

    await third.goto("/");
    await third.locator("#playerName").fill("ThirdPlayer");
    await third.locator("#roomName").fill("pw-host-handoff");
    await third.getByRole("button", { name: "방 참가" }).click();
    await expect(third.locator("#message")).toHaveText("방 참가 완료!");

    await hostContext.close();

    await expect(guest.locator("#start")).toBeVisible();
    await guest.locator("#start").click();
    await expect(guest.locator("#battle")).toBeVisible();
    await expect(third.locator("#battle")).toBeVisible();
    await expect(guest.locator("#turnText")).toContainText("NewHost");
  } finally {
    await hostContext.close();
    await guestContext.close();
    await thirdContext.close();
  }
});
