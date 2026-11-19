import { expect, test } from "./support/fixtures.ts";

// Signing out invalidates the shared session cookie, so this spec must run after every spec that uses it.
// Playwright runs files alphabetically: agenda, appointments, logout, pwa (which needs no session).
test.describe("logout", () => {
  test("logout returns to the login page", async ({ page, agenda, state }) => {
    await agenda.open(state);
    await agenda.logout.click();
    await expect(page).toHaveURL(/\/login$/);
  });
});
