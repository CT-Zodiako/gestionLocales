import type { Locator, Page } from "@playwright/test";
import { addDays } from "./support/dates.ts";
import { BookingDialog, DetailDialog } from "./support/dialogs.ts";
import { expect, test } from "./support/fixtures.ts";

const GENERIC_ERROR = "Ocurrió un error. Inténtalo de nuevo.";
const SLOT_TAKEN = "Ese horario ya está ocupado";
const MIN_TOUCH_TARGET = 40;

/**
 * Create, move and cancel through the real UI against the Docker stack. The seeded owner is shared by every spec,
 * so each test arranges its own appointments (through the API) at hours or days nobody else uses:
 * today 08:00 (404 on move), 12:30 (cancel), 14:30 (cancel 500), 16:00-19:30 (move), 20:00 (404 on cancel),
 * tomorrow 17:00 and 18:00 (slot, 500), and days 40+ ahead for the toolbar flows.
 */
const farDay = (today: string, offset: number) => addDays(today, 40 + offset);

/** Counts the requests of a method whose path matches, from now on. */
function countRequests(page: Page, method: string, path: RegExp): { count: () => number } {
  let total = 0;
  page.on("request", (request) => {
    if (request.method() === method && path.test(new URL(request.url()).pathname)) total += 1;
  });
  return { count: () => total };
}

/** Waits for the dialog's open animation (it scales in), so sizes are measured at rest. */
async function settled(dialog: Locator): Promise<void> {
  await dialog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
}

async function expectTouchTargets(dialog: Locator, controls: Locator[]): Promise<void> {
  await settled(dialog);
  for (const control of controls) {
    const box = await control.boundingBox();
    expect(box, "control is rendered").toBeTruthy();
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET - 0.5);
  }
}

/** The page and the dialog have no horizontal overflow and the dialog sits inside the viewport. */
async function expectFitsViewport(page: Page, dialog: Locator, width: number): Promise<void> {
  await settled(dialog);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const dialogOverflow = await dialog.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(dialogOverflow).toBeLessThanOrEqual(0);
  const box = await dialog.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
}

// Playwright cannot reliably intercept (`page.route`) the requests of a page that a service worker controls, and
// the worker registers at an unpredictable moment of each test; these flows do not depend on it (pwa.spec.ts does).
test.use({ serviceWorkers: "block" });

test.describe("create", () => {
  test("from the toolbar: normalizes the phone, shows the end time, lands in the grid and the week view", async ({
    page,
    agenda,
    state,
  }) => {
    const date = farDay(state.dates.today, 0);
    const booking = new BookingDialog(page);
    await agenda.open(state);

    await agenda.newAppointment.click();
    await expect(booking.root).toBeVisible();
    // The dialog opens on the date the agenda shows, with no hour chosen.
    await expect(booking.date).toHaveValue(state.dates.today);
    await expect(booking.time).toHaveValue("");

    await booking.fill({ phone: "+57 300 123-4567", name: "Eva Toolbar", service: "Tinte", date, time: "10:15" });
    await expect(booking.endTime).toHaveText("Termina a las 11:15");
    await booking.submit.click();

    await expect(booking.root).toBeHidden();
    await expect(agenda.newAppointment).toBeFocused();
    // The agenda follows the booking to its date and shows it at 10:15, one hour long.
    const block = agenda.block("Eva Toolbar");
    await expect(block).toBeVisible();
    await expect(block).toContainText("Tinte");
    await agenda.expectBlockAt(block, "10", 15, 60);

    await agenda.weekToggle.click();
    await expect(agenda.block("Eva Toolbar", agenda.column(date))).toBeVisible();
  });

  test("the phone is sent normalized and the same customer is reused", async ({ page, agenda, state, api }) => {
    const date = farDay(state.dates.today, 3);
    const booking = new BookingDialog(page);
    await agenda.open(state);

    await agenda.newAppointment.click();
    await booking.fill({ phone: "+57 311 765-4321", name: "Pía Phone", service: "Corte", date, time: "08:00" });
    await booking.submit.click();
    await expect(booking.root).toBeHidden();

    await agenda.newAppointment.click();
    await booking.fill({ phone: "573117654321", service: "Corte", date, time: "09:00" });
    await booking.submit.click();
    await expect(booking.root).toBeHidden();
    await expect(agenda.blocks()).toHaveCount(2);

    const booked = await api.onDate(date, addDays(date, 1));
    expect(booked.map((appointment) => appointment.customerPhone)).toEqual(["573117654321", "573117654321"]);
    expect(new Set(booked.map((appointment) => appointment.customerId)).size).toBe(1);
  });

  test("from an empty slot of the day grid: the hour is prefilled and the booking lands in that hour", async ({
    page,
    agenda,
    state,
  }) => {
    const booking = new BookingDialog(page);
    await agenda.open(state);
    await agenda.next.click();
    await expect(agenda.block("Beto Mañana")).toBeVisible();

    const slot = agenda.slot("17");
    await slot.click();
    await expect(booking.root).toBeVisible();
    await expect(booking.date).toHaveValue(state.dates.tomorrow);
    await expect(booking.time).toHaveValue("17:00");

    await booking.fill({ phone: "573005550017", name: "Eva Slot", service: "Corte" });
    await booking.submit.click();
    await expect(booking.root).toBeHidden();
    await expect(slot).toBeFocused();

    const block = agenda.block("Eva Slot");
    await expect(block).toBeVisible();
    await agenda.expectBlockAt(block, "17", 0, 30);
  });

  test("client-side validation: messages announced as alerts, nothing sent, and they clear as the input is fixed", async ({
    page,
    agenda,
    state,
  }) => {
    const booking = new BookingDialog(page);
    const posts = countRequests(page, "POST", /^\/api\/(appointments|services)$/);
    await agenda.open(state);
    await agenda.newAppointment.click();

    await booking.date.fill("");
    await booking.submit.click();
    await expect(booking.alerts).toHaveText([
      "Ingresa el teléfono del cliente",
      "Elige un servicio",
      "Elige una fecha",
      "Elige una hora",
    ]);
    await expect(booking.phone).toBeFocused();
    await expect(booking.phone).toHaveAttribute("aria-invalid", "true");

    await booking.phone.fill("12345");
    await booking.submit.click();
    await expect(booking.alerts.first()).toHaveText("El teléfono debe tener entre 8 y 15 dígitos");

    await booking.fill({ phone: "(300) 123-4567", service: "Corte", date: state.dates.tomorrow, time: "08:00" });
    await expect(booking.alerts).toHaveCount(0);
    await expect(booking.root).toBeVisible();
    expect(posts.count()).toBe(0);
  });

  test("an overlap keeps the dialog open with the input, leaves the grid unchanged, and a new time then succeeds", async ({
    page,
    agenda,
    state,
    api,
  }) => {
    const date = farDay(state.dates.today, 4);
    const booking = new BookingDialog(page);
    await agenda.open(state);
    await expect(agenda.block("Ana Pérez")).toBeVisible(); // 09:00-09:30 today
    const before = await agenda.blocks().count();
    const bookedBefore = (await api.onDate(state.dates.today, state.dates.tomorrow)).filter((a) => a.status === "booked").length;

    await agenda.newAppointment.click();
    await booking.fill({ phone: "+57 300 555-0001", name: "Otra Persona", service: "Corte", time: "09:15" });
    await booking.submit.click();

    await expect(booking.alerts).toHaveText(SLOT_TAKEN);
    await expect(booking.root).toBeVisible();
    await expect(booking.submit).toBeEnabled();
    await expect(booking.phone).toHaveValue("+57 300 555-0001");
    await expect(booking.name).toHaveValue("Otra Persona");
    await expect(booking.service).toHaveText("Corte");
    await expect(booking.date).toHaveValue(state.dates.today);
    await expect(booking.time).toHaveValue("09:15");
    await expect(agenda.blocks()).toHaveCount(before);
    await expect(agenda.block("Otra Persona")).toHaveCount(0);
    const booked = (await api.onDate(state.dates.today, state.dates.tomorrow)).filter((a) => a.status === "booked");
    expect(booked).toHaveLength(bookedBefore);

    // Same input, another slot: the retry goes through and the error is gone.
    await booking.date.fill(date);
    await booking.time.fill("09:00");
    await booking.submit.click();
    await expect(booking.root).toBeHidden();
    await expect(agenda.block("Otra Persona")).toBeVisible();
  });

  test("a service created inline (with its own validation) is selected and used for the booking", async ({
    page,
    agenda,
    state,
  }) => {
    const date = farDay(state.dates.today, 5);
    const booking = new BookingDialog(page);
    const servicePosts = countRequests(page, "POST", /^\/api\/services$/);

    // The seeded business has services; pretend it has none until one is created through the inline form.
    let created = false;
    page.on("response", (response) => {
      if (response.request().method() === "POST" && new URL(response.url()).pathname === "/api/services" && response.status() === 201) {
        created = true;
      }
    });
    await page.route("**/api/services", (route) =>
      route.request().method() === "GET" && !created
        ? route.fulfill({ status: 200, contentType: "application/json", body: '{"services":[]}' })
        : route.continue(),
    );
    await agenda.open(state);
    await agenda.newAppointment.click();

    await expect(booking.newService.heading).toBeVisible();
    await expect(booking.service).toBeDisabled();
    await booking.newService.submit.click();
    await expect(booking.alerts).toHaveText([
      "Ingresa el nombre del servicio",
      "La duración debe ser un número entero de minutos entre 1 y 1440",
    ]);
    await expect(booking.newService.name).toBeFocused();
    expect(servicePosts.count()).toBe(0);

    await booking.newService.duration.fill("0");
    await booking.newService.name.fill("Masaje E2E");
    await booking.newService.submit.click();
    await expect(booking.alerts).toHaveText("La duración debe ser un número entero de minutos entre 1 y 1440");

    await booking.newService.duration.fill("45");
    await booking.newService.submit.click();
    await expect(booking.newService.heading).toBeHidden();
    await expect(booking.service).toBeEnabled();
    await expect(booking.service).toHaveText("Masaje E2E");

    await booking.fill({ phone: "573005550005", name: "Maribel Masaje", date, time: "09:00" });
    await expect(booking.endTime).toHaveText("Termina a las 09:45");
    await booking.submit.click();
    await expect(booking.root).toBeHidden();
    const block = agenda.block("Maribel Masaje");
    await expect(block).toContainText("Masaje E2E");
    await agenda.expectBlockAt(block, "09", 0, 45);
  });

  test("a 500 shows the generic message, keeps the dialog and the input, and a retry works", async ({
    page,
    agenda,
    state,
  }) => {
    const booking = new BookingDialog(page);
    await agenda.open(state);
    await agenda.next.click();

    await page.route("**/api/appointments", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' })
        : route.continue(),
    );
    await agenda.newAppointment.click();
    await booking.fill({ phone: "573005550018", name: "Reina Reintento", service: "Corte", time: "18:00" });
    await booking.submit.click();

    await expect(booking.alerts).toHaveText(GENERIC_ERROR);
    await expect(booking.root).toBeVisible();
    await expect(booking.submit).toBeEnabled();
    await expect(booking.phone).toHaveValue("573005550018");
    await expect(booking.name).toHaveValue("Reina Reintento");
    await expect(booking.time).toHaveValue("18:00");
    await expect(agenda.block("Reina Reintento")).toHaveCount(0);

    await page.unroute("**/api/appointments");
    await booking.submit.click();
    await expect(booking.root).toBeHidden();
    await expect(agenda.block("Reina Reintento")).toBeVisible();
  });

  test("a 400 and a 404 on create map to their messages and keep the input; a 404 also refreshes the services", async ({
    page,
    agenda,
    state,
  }) => {
    const booking = new BookingDialog(page);
    const serviceLists = countRequests(page, "GET", /^\/api\/services$/);
    await agenda.open(state);
    await agenda.next.click();

    let answer: { status: number; body: string } = { status: 400, body: '{"error":"invalid_request"}' };
    await page.route("**/api/appointments", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: answer.status, contentType: "application/json", body: answer.body })
        : route.continue(),
    );
    await agenda.newAppointment.click();
    await booking.fill({ phone: "573005550019", name: "Gabi Gris", service: "Corte", time: "19:00" });
    await booking.submit.click();
    await expect(booking.alerts).toHaveText("El servidor no aceptó los datos. Revisa el formulario e inténtalo de nuevo.");
    await expect(booking.root).toBeVisible();

    const listsBefore = serviceLists.count();
    answer = { status: 404, body: '{"error":"not_found"}' };
    await booking.submit.click();
    await expect(booking.alerts).toHaveText("El servicio elegido ya no existe. Actualizamos la lista.");
    await expect.poll(serviceLists.count).toBeGreaterThan(listsBefore);
    await expect(booking.root).toBeVisible();
    await expect(booking.phone).toHaveValue("573005550019");
    await expect(booking.name).toHaveValue("Gabi Gris");
    await expect(booking.time).toHaveValue("19:00");
    await expect(agenda.block("Gabi Gris")).toHaveCount(0);
  });

  test("a failure loading the services is announced with Reintentar, and booking works after it", async ({
    page,
    agenda,
    state,
  }) => {
    const booking = new BookingDialog(page);
    await agenda.open(state);
    await page.route("**/api/services", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }),
    );
    await agenda.newAppointment.click();
    await expect(booking.alerts).toHaveText("No se pudieron cargar los servicios.Reintentar");
    await expect(booking.service).toBeDisabled();
    await expect(booking.newService.heading).toHaveCount(0); // an outage is not "no services"

    await page.unroute("**/api/services");
    await booking.root.getByRole("button", { name: "Reintentar" }).click();
    await expect(booking.service).toBeEnabled();
    await expect(booking.alerts).toHaveCount(0);
  });

  test("a double click on the submit button sends a single request", async ({ page, agenda, state, api }) => {
    const date = farDay(state.dates.today, 2);
    const booking = new BookingDialog(page);
    const posts = countRequests(page, "POST", /^\/api\/appointments$/);
    await agenda.open(state);

    // A slow API keeps the first request pending while the second click lands.
    await page.route("**/api/appointments", async (route) => {
      if (route.request().method() === "POST") await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    });
    await agenda.newAppointment.click();
    await booking.fill({ phone: "573005550011", name: "Dani Doble", service: "Corte", date, time: "11:00" });
    await booking.submit.dblclick();

    await expect(booking.root).toBeHidden();
    await expect(agenda.block("Dani Doble")).toBeVisible();
    expect(posts.count()).toBe(1);
    expect(await api.onDate(date, addDays(date, 1))).toHaveLength(1);
  });
});

test.describe("detail, move and cancel", () => {
  test("move keeps the duration, updates the grid, and an occupied slot is refused leaving the original", async ({
    page,
    agenda,
    state,
    api,
  }) => {
    const { today, tomorrow } = state.dates;
    await api.book("Tinte", today, "16:00", "573005550101", "Tina Tinte");
    await api.book("Corte", today, "19:00", "573005550102", "Otto Ocupado");
    const detail = new DetailDialog(page);
    await agenda.open(state);

    const block = agenda.block("Tina Tinte");
    await agenda.expectBlockAt(block, "16", 0, 60);
    await block.click();
    await expect(detail.root).toBeVisible();
    await expect(detail.root.getByRole("heading", { name: "Tina Tinte" })).toBeVisible();
    await expect(detail.root).toContainText("Tinte");
    await expect(detail.root).toContainText("16:00–17:00");
    await expect(detail.root).toContainText("+573005550101");

    await detail.move.click();
    await expect(detail.date).toHaveValue(today);
    await expect(detail.time).toHaveValue("16:00");
    await expect(detail.endTime).toHaveText("Termina a las 17:00");
    await detail.time.fill("17:30");
    await expect(detail.endTime).toHaveText("Termina a las 18:30");
    await detail.submitMove.click();

    await expect(detail.root).toBeHidden();
    await expect(block).toBeFocused();
    await agenda.expectBlockAt(block, "17", 30, 60); // still one hour long
    expect((await api.onDate(today, tomorrow)).find((a) => a.customerPhone === "573005550101")?.startsAt).toContain(
      "T22:30:00",
    );

    // Into the slot of "Otto Ocupado" (19:00-19:30): refused, the dialog keeps the typed time.
    await block.click();
    await detail.move.click();
    await detail.time.fill("19:15");
    await detail.submitMove.click();
    await expect(detail.alerts).toHaveText(SLOT_TAKEN);
    await expect(detail.root).toBeVisible();
    await expect(detail.time).toHaveValue("19:15");
    await expect(detail.submitMove).toBeEnabled();
    await agenda.expectBlockAt(block, "17", 30, 60);

    // Moving to another day works and the agenda follows it there.
    await detail.date.fill(tomorrow);
    await detail.time.fill("07:30");
    await detail.submitMove.click();
    await expect(detail.root).toBeHidden();
    await agenda.expectBlockAt(agenda.block("Tina Tinte"), "07", 30, 60);
    await agenda.previous.click();
    await expect(agenda.block("Tina Tinte")).toHaveCount(0);
    await expect(agenda.block("Otto Ocupado")).toBeVisible();
  });

  test("cancel asks for confirmation; dismissing keeps the appointment; confirming hides it until the toggle", async ({
    page,
    agenda,
    state,
    api,
  }) => {
    const { today, tomorrow } = state.dates;
    await api.book("Corte", today, "12:30", "573005550201", "Cora Cancelar");
    const detail = new DetailDialog(page);
    const cancels = countRequests(page, "POST", /^\/api\/appointments\/[^/]+\/cancel$/);
    await agenda.open(state);

    await agenda.block("Cora Cancelar").click();
    await detail.cancelAppointment.click();
    await expect(detail.root).toContainText("¿Cancelar esta cita?");
    await expect(detail.keepAppointment).toBeFocused();
    await detail.keepAppointment.click();
    await expect(detail.root).toBeVisible();
    await expect(detail.confirmCancel).toBeHidden();
    await expect(detail.cancelAppointment).toBeVisible();
    expect(cancels.count()).toBe(0);
    await expect(agenda.block("Cora Cancelar")).toHaveAttribute("data-status", "booked");

    await detail.cancelAppointment.click();
    await detail.confirmCancel.click();
    await expect(detail.root).toBeHidden();
    expect(cancels.count()).toBe(1);
    await expect(agenda.block("Cora Cancelar")).toHaveCount(0);
    expect((await api.onDate(today, tomorrow)).find((a) => a.customerPhone === "573005550201")?.status).toBe("cancelled");

    await agenda.cancelledToggle.click();
    const cancelled = agenda.block("Cora Cancelar");
    await expect(cancelled).toHaveAttribute("data-status", "cancelled");
    // A cancelled appointment opens read-only: nothing to move or cancel.
    await cancelled.click();
    await expect(detail.root).toContainText("Cancelada");
    await expect(detail.move).toHaveCount(0);
    await expect(detail.cancelAppointment).toHaveCount(0);
    await page.keyboard.press("Escape");
    await agenda.cancelledToggle.click();
    await expect(agenda.block("Cora Cancelar")).toHaveCount(0);
  });

  test("moving an appointment cancelled meanwhile shows the not-found message and refreshes the agenda", async ({
    page,
    agenda,
    state,
    api,
  }) => {
    const id = await api.book("Corte", state.dates.today, "08:00", "573005550301", "Nora Nula");
    const detail = new DetailDialog(page);
    await agenda.open(state);

    await agenda.block("Nora Nula").click();
    await api.cancel(id); // someone else cancels it while the dialog is open
    await detail.move.click();
    await detail.time.fill("08:30");
    await detail.submitMove.click();

    await expect(detail.alerts).toHaveText("Esa cita ya no existe. Actualizamos la agenda.");
    await expect(detail.root).toBeVisible();
    await expect(detail.time).toHaveValue("08:30");
    await expect(agenda.block("Nora Nula")).toHaveCount(0);
  });

  test("cancelling an appointment cancelled meanwhile shows the not-found message and refreshes the agenda", async ({
    page,
    agenda,
    state,
    api,
  }) => {
    const id = await api.book("Corte", state.dates.today, "20:00", "573005550302", "Nico Nulo");
    const detail = new DetailDialog(page);
    await agenda.open(state);

    await agenda.block("Nico Nulo").click();
    await api.cancel(id);
    await detail.cancelAppointment.click();
    await detail.confirmCancel.click();

    await expect(detail.alerts).toHaveText("Esa cita ya no existe. Actualizamos la agenda.");
    await expect(detail.root).toBeVisible();
    await expect(agenda.block("Nico Nulo")).toHaveCount(0);
    await detail.root.getByRole("button", { name: "Cerrar" }).first().click();
    await expect(detail.root).toBeHidden();
  });

  test("a 500 on cancel shows the generic message, keeps the dialog and the appointment, and a retry works", async ({
    page,
    agenda,
    state,
    api,
  }) => {
    await api.book("Corte", state.dates.today, "14:30", "573005550401", "Rita Rota");
    const detail = new DetailDialog(page);
    await agenda.open(state);

    await page.route(/\/api\/appointments\/[^/]+\/cancel$/, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }),
    );
    await agenda.block("Rita Rota").click();
    await detail.cancelAppointment.click();
    await detail.confirmCancel.click();
    await expect(detail.alerts).toHaveText(GENERIC_ERROR);
    await expect(detail.root).toBeVisible();
    await expect(detail.confirmCancel).toBeEnabled();
    await expect(agenda.block("Rita Rota")).toHaveAttribute("data-status", "booked");

    await page.unroute(/\/api\/appointments\/[^/]+\/cancel$/);
    await detail.confirmCancel.click();
    await expect(detail.root).toBeHidden();
    await expect(agenda.block("Rita Rota")).toHaveCount(0);
  });
});

test.describe("keyboard and focus", () => {
  test("the booking dialog is reachable by keyboard, traps Tab in a sensible order, closes with Escape and returns focus", async ({
    page,
    agenda,
    state,
  }) => {
    const booking = new BookingDialog(page);
    await agenda.open(state);

    await agenda.newAppointment.focus();
    await page.keyboard.press("Enter");
    await expect(booking.root).toBeVisible();
    await expect(booking.phone).toBeFocused(); // focus moved into the dialog

    // Native date and time inputs have several Tab stops (day, month, ...): compare the sequence of distinct controls.
    const order: string[] = [];
    for (let presses = 0; presses < 30 && !order.includes("Cerrar"); presses += 1) {
      await page.keyboard.press("Tab");
      const label = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        const labelled = (element as HTMLInputElement | null)?.labels?.[0]?.textContent;
        return (labelled ?? element?.getAttribute("aria-label") ?? element?.textContent ?? "").trim();
      });
      if (order.at(-1) !== label) order.push(label);
    }
    expect(order).toEqual([
      "Nombre del cliente (opcional)",
      "Servicio",
      "Fecha",
      "Hora",
      "Cancelar",
      "Agendar cita",
      "Cerrar",
    ]);
    await page.keyboard.press("Tab");
    await expect(booking.phone).toBeFocused(); // focus stays trapped in the dialog

    await page.keyboard.press("Escape");
    await expect(booking.root).toBeHidden();
    await expect(agenda.newAppointment).toBeFocused();
  });

  test("an appointment block opens its detail with Enter and Escape returns focus to it", async ({ page, agenda, state }) => {
    const detail = new DetailDialog(page);
    await agenda.open(state);
    const block = agenda.block("Ana Pérez");

    await block.focus();
    await page.keyboard.press("Enter");
    await expect(detail.root).toBeVisible();
    await expect(detail.root.locator(":focus")).toHaveCount(1); // focus is inside the dialog
    await expect(detail.root.getByRole("heading", { name: "Ana Pérez" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(detail.root).toBeHidden();
    await expect(block).toBeFocused();
  });
});

test.describe("375px viewport", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("booking dialog, its errors and the inline service form fit without horizontal overflow, with 40px targets", async ({
    page,
    agenda,
    state,
  }) => {
    const booking = new BookingDialog(page);
    await page.route("**/api/services", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 200, contentType: "application/json", body: '{"services":[]}' })
        : route.continue(),
    );
    await agenda.open(state);
    await agenda.newAppointment.click();
    await expect(booking.newService.heading).toBeVisible();

    await expectFitsViewport(page, booking.root, 375);
    await expectTouchTargets(booking.root, [
      booking.newService.name,
      booking.newService.duration,
      booking.newService.submit,
      booking.phone,
      booking.name,
      booking.service,
      booking.date,
      booking.time,
      booking.cancel,
      booking.submit,
      booking.root.getByRole("button", { name: "Cerrar" }),
    ]);

    await booking.newService.submit.click();
    await booking.submit.click();
    await expect(booking.alerts.first()).toBeVisible();
    await expectFitsViewport(page, booking.root, 375);
  });

  test("detail dialog, move form and cancel confirmation fit without horizontal overflow, with 40px targets", async ({
    page,
    agenda,
    state,
  }) => {
    const detail = new DetailDialog(page);
    await agenda.open(state);
    await agenda.block("Ana Pérez").click();
    await expect(detail.root).toBeVisible();
    await expectFitsViewport(page, detail.root, 375);
    await expectTouchTargets(detail.root, [detail.move, detail.cancelAppointment]);

    await detail.cancelAppointment.click();
    await expectFitsViewport(page, detail.root, 375);
    await expectTouchTargets(detail.root, [detail.confirmCancel, detail.keepAppointment]);
    await detail.keepAppointment.click();

    await detail.move.click();
    await expectFitsViewport(page, detail.root, 375);
    await expectTouchTargets(detail.root, [detail.date, detail.time, detail.submitMove, detail.back]);
  });
});
