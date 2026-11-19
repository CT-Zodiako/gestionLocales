import { addDays } from "./support/dates.ts";
import { anonymous, expect, test } from "./support/fixtures.ts";

/** Tolerance in px for borders and sub-pixel layout. */
const TOLERANCE = 2;

// Most specs start from the session cookie of the seeded owner (see support/fixtures.ts).
test.describe("agenda", () => {
  test("week view puts the appointments in their day columns, Monday first", async ({ agenda, state }) => {
    const { monday, sunday, today } = state.dates;
    await agenda.open(state);
    await agenda.weekToggle.click();

    const columns = agenda.page.getByTestId(/^day-\d{4}-\d{2}-\d{2}$/);
    await expect(columns).toHaveCount(7);
    await expect(columns.first()).toHaveAttribute("data-testid", `day-${monday}`);
    await expect(columns.last()).toHaveAttribute("data-testid", `day-${sunday}`);

    await expect(agenda.block("Luis Lunes", agenda.column(monday))).toBeVisible();
    await expect(agenda.block("Dora Domingo", agenda.column(sunday))).toBeVisible();
    await expect(agenda.block("Ana Pérez", agenda.column(today))).toBeVisible();
    await expect(agenda.block("+573001110002", agenda.column(today))).toBeVisible();
    // Appointments never leak into another column.
    await expect(agenda.block("Luis Lunes", agenda.column(sunday))).toHaveCount(0);
  });

  test("previous, next and today change the range and the appointments shown", async ({ agenda, state }) => {
    await agenda.open(state);
    const todayLabel = await agenda.rangeLabel.innerText();

    await agenda.next.click();
    await expect(agenda.rangeLabel).not.toHaveText(todayLabel);
    await expect(agenda.block("Beto Mañana")).toBeVisible();
    await expect(agenda.block("Ana Pérez")).toHaveCount(0);

    await agenda.todayButton.click();
    await expect(agenda.rangeLabel).toHaveText(todayLabel);
    await expect(agenda.block("Ana Pérez")).toBeVisible();

    await agenda.previous.click();
    await expect(agenda.block("Carla Ayer")).toBeVisible();
    await expect(agenda.block("Ana Pérez")).toHaveCount(0);

    // In week view the buttons move by a week.
    await agenda.todayButton.click();
    await agenda.weekToggle.click();
    const weekLabel = await agenda.rangeLabel.innerText();
    await agenda.next.click();
    await expect(agenda.rangeLabel).not.toHaveText(weekLabel);
    await expect(agenda.column(addDays(state.dates.monday, 7))).toBeVisible();
    await expect(agenda.block("Luis Lunes")).toHaveCount(0);
    await agenda.previous.click();
    await expect(agenda.rangeLabel).toHaveText(weekLabel);
    await expect(agenda.block("Luis Lunes")).toBeVisible();
  });

  test("cancelled appointments are hidden by default and shown muted with the toggle", async ({ agenda, state }) => {
    await agenda.open(state);
    await expect(agenda.block("Ana Pérez")).toBeVisible();
    await expect(agenda.block("Clara Cita")).toHaveCount(0);
    await expect(agenda.cancelledToggle).toHaveAttribute("aria-pressed", "false");

    await agenda.cancelledToggle.click();
    await expect(agenda.cancelledToggle).toHaveAttribute("aria-pressed", "true");
    const cancelled = agenda.block("Clara Cita");
    await expect(cancelled).toBeVisible();
    await expect(cancelled).toHaveAttribute("data-status", "cancelled");
    await expect(cancelled).toContainText("Cancelada");
    await expect(agenda.block("Ana Pérez")).toHaveAttribute("data-status", "booked");

    await agenda.cancelledToggle.click();
    await expect(agenda.block("Clara Cita")).toHaveCount(0);
  });

  test("a day without appointments shows the empty state", async ({ page, agenda, state }) => {
    await agenda.open(state);
    await agenda.next.click();
    await agenda.next.click(); // the day after tomorrow has nothing seeded
    await expect(page.getByText("No hay citas para este día.")).toBeVisible();
    await expect(agenda.blocks()).toHaveCount(0);
  });

  test("an API 500 shows the error state and Reintentar recovers", async ({ page, agenda, state }) => {
    await agenda.open(state);
    await agenda.next.click();
    await expect(agenda.block("Beto Mañana")).toBeVisible();

    let fail = true;
    await page.route(/\/api\/appointments\?/, (route) =>
      fail ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }) : route.continue(),
    );
    await agenda.next.click(); // a new range, so the query runs (and fails) again
    await expect(page.getByRole("alert")).toContainText("No se pudieron cargar las citas");
    await expect(agenda.blocks()).toHaveCount(0);

    fail = false;
    await page.getByRole("button", { name: "Reintentar" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText("No hay citas para este día.")).toBeVisible();
  });

  test("in-app navigation while offline shows the error state with Reintentar, and recovers online", async ({
    page,
    context,
    agenda,
    state,
  }) => {
    await agenda.open(state);
    await expect(agenda.block("Ana Pérez")).toBeVisible();

    await context.setOffline(true);
    await agenda.next.click(); // tomorrow was never loaded, so the query has to hit the network
    await expect(page.getByRole("alert")).toContainText("No se pudieron cargar las citas");
    await expect(page.getByRole("button", { name: "Reintentar" })).toBeVisible();
    await expect(page.getByText("Cargando citas…")).toHaveCount(0);

    await context.setOffline(false);
    await page.getByRole("button", { name: "Reintentar" }).click();
    await expect(agenda.block("Beto Mañana")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("the scrollable agenda container can be reached with the keyboard and shows a focus ring", async ({
    page,
    agenda,
    state,
  }) => {
    await agenda.open(state);
    const container = page.getByRole("main");
    for (let presses = 0; presses < 15; presses += 1) {
      if (await container.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(container).toBeFocused();
    const boxShadow = await container.evaluate((element) => getComputedStyle(element).boxShadow);
    expect(boxShadow).not.toBe("none");
  });

  for (const view of ["day", "week"] as const) {
    test(`375px viewport has no horizontal overflow in ${view} view`, async ({ page, agenda, state }) => {
      await page.setViewportSize({ width: 375, height: 800 });
      await agenda.open(state);
      if (view === "week") await agenda.weekToggle.click();
      await expect(agenda.block("Ana Pérez")).toBeVisible();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      // The whole toolbar stays inside the viewport.
      const controls = [agenda.previous, agenda.todayButton, agenda.next, agenda.dayToggle, agenda.weekToggle, agenda.cancelledToggle, agenda.logout];
      for (const control of controls) {
        const box = await control.boundingBox();
        expect(box).toBeTruthy();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(375);
      }
    });
  }
});

// Sign-ins are rate limited by Better Auth (3 per 10 s), so only this spec uses the login form.
test.describe("login form", () => {
  test.use({ storageState: anonymous });

  test("login shows the day view with the seeded appointments at the right hour and duration", async ({
    page,
    agenda,
    state,
    consoleErrors,
  }) => {
    test.setTimeout(60_000); // the form sign-in may have to wait for the rate-limit window
    await agenda.login(state);

    await expect(agenda.dayToggle).toBeChecked();
    await expect(agenda.block("Ana Pérez")).toBeVisible();
    await expect(agenda.block("Ana Pérez")).toContainText("Corte");
    // A customer without a name is shown by phone.
    await expect(agenda.block("+573001110002")).toContainText("Tinte");

    const ana = await agenda.block("Ana Pérez").boundingBox();
    const tinte = await agenda.block("+573001110002").boundingBox();
    const nine = await agenda.hourRow("09").boundingBox();
    const eleven = await agenda.hourRow("11").boundingBox();
    expect(ana && tinte && nine && eleven).toBeTruthy();

    // Starts at the top of its hour row; 30 min is half an hour row, 60 min is one hour row.
    expect(Math.abs(ana!.y - nine!.y)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(ana!.height - nine!.height / 2)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(tinte!.y - eleven!.y)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(tinte!.height - eleven!.height)).toBeLessThanOrEqual(TOLERANCE);

    // Only today's appointments are listed, and the cancelled one is hidden by default.
    await expect(agenda.block("Beto Mañana")).toHaveCount(0);
    await expect(agenda.block("Clara Cita")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: state.businessName })).toBeVisible();
    expect(consoleErrors).toEqual([]);
  });

  test("owner B never sees owner A's appointments after signing out and in again without a reload", async ({
    page,
    agenda,
    state,
  }) => {
    test.setTimeout(60_000); // two form sign-ins may have to wait for the rate-limit window
    const { ownerB } = state;

    await agenda.login(state);
    await expect(agenda.block("Ana Pérez")).toBeVisible();
    await expect(agenda.block("+573001110002")).toBeVisible();

    await agenda.logout.click();
    await expect(page).toHaveURL(/\/login$/);
    // No reload from here on: the SPA (and its query cache) stays alive between the two sessions.
    await agenda.signInFromForm(ownerB);

    await expect(agenda.block("Bruno Beta")).toBeVisible();
    await expect(agenda.block("+573002220002")).toBeVisible();
    for (const name of ["Ana Pérez", "+573001110002"]) await expect(agenda.block(name)).toHaveCount(0);
    await expect(agenda.blocks()).toHaveCount(2);

    // Still true after a short wait (a late refetch must not bring A's data back either).
    await page.waitForTimeout(1_500);
    await expect(agenda.blocks()).toHaveCount(2);
    await expect(page.getByText("Ana Pérez")).toHaveCount(0);
  });
});
