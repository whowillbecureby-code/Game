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

test("two players can take six consecutive card-play turns", async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();

  try {
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    await host.goto("/");
    await host.locator("#playerName").fill("SimulationHost");
    await host.locator("#roomName").fill("pw-card-simulation");
    await host.getByRole("button", { name: "방 만들기" }).click();
    await expect(host.locator("#message")).toHaveText("방 참가 완료!");

    await guest.goto("/");
    await guest.locator("#playerName").fill("SimulationGuest");
    await guest.locator("#roomName").fill("pw-card-simulation");
    await guest.getByRole("button", { name: "방 참가" }).click();
    await expect(guest.locator("#message")).toHaveText("방 참가 완료!");

    await host.locator("#start").click();
    await expect(host.locator("#battle")).toBeVisible();
    await expect(guest.locator("#battle")).toBeVisible();

    for (let turn = 0; turn < 6; turn++) {
      const current = turn % 2 === 0 ? host : guest;
      const next = turn % 2 === 0 ? guest : host;
      const currentName = turn % 2 === 0 ? "SimulationHost" : "SimulationGuest";
      const nextName = turn % 2 === 0 ? "SimulationGuest" : "SimulationHost";

      await expect(current.locator("#turnText")).toContainText(currentName);
      const card = current.locator("#hand .card").first();
      await expect(card).toBeEnabled();
      const cardName = await card.locator("strong").innerText();

      await card.click();
      const useButton = current.locator("#targets button").first();
      await expect(useButton).toBeVisible();
      await useButton.click();

      await expect(current.locator("#log")).toContainText(
        currentName + " 님이 " + cardName + " 사용"
      );
      await expect(next.locator("#turnText")).toContainText(nextName);
    }
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

