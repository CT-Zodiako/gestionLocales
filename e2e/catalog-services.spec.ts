import type { Page } from "@playwright/test";
import { anonymous, expect, test } from "./support/fixtures.ts";
import { BookingDialog, DetailDialog } from "./support/dialogs.ts";
import { expectDialogFits, expectNoPageOverflow, expectTouchTargets, settled } from "./support/layout.ts";
import { ServiceDialog, ServicesPage } from "./support/services.ts";

// File name: Playwright runs the files alphabetically (agenda, appearance, appointments, catalog-services, logout,
// pwa) and `logout.spec.ts` invalidates the session cookie every spec shares, so this spec has to sort before it.
// "catalog-services" does under any ordering (plain code-unit or locale), unlike names that start with "services"
// (after logout) or hyphen/dot variants of "agenda" (their order against `agenda.spec.ts` depends on the collation).
// It also runs after `appointments.spec.ts`, which owns the shared services "Corte" and "Tinte"; this spec only
// adds services with its own names, and teardown deletes every row of the seeded business.

const GENERIC_ERROR = "Ocurrió un error. Inténtalo de nuevo.";
const NAME_REQUIRED = "Ingresa el nombre del servicio";
const DURATION_INVALID = "La duración debe ser un número entero de minutos entre 1 y 1440";
const PRICE_INVALID = "El precio debe ser un número entero de pesos, sin decimales";
const PRICE_TOO_HIGH = "El precio no puede superar $100.000.000";
const NOT_FOUND = "Ese servicio ya no existe. Actualizamos la lista.";

/** Counts the requests of a method whose path matches, from now on. */
function countRequests(page: Page, method: string, path: RegExp): { count: () => number; bodies: () => unknown[] } {
  const bodies: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === method && path.test(new URL(request.url()).pathname)) {
      bodies.push(request.postData() === null ? null : JSON.parse(request.postData() as string));
    }
  });
  return { count: () => bodies.length, bodies: () => bodies };
}

// Playwright cannot reliably intercept (`page.route`) the requests of a page that a service worker controls.
test.use({ serviceWorkers: "block" });

test.describe("navigation and list", () => {
  test("Servicios is reachable from the agenda header with the keyboard, and Agenda leads back", async ({
    page,
    agenda,
    state,
  }) => {
    const services = new ServicesPage(page);
    await agenda.open(state);
    await expect(services.agendaLink).toHaveAttribute("aria-current", "page");

    await services.servicesLink.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/servicios$/);
    await expect(services.heading).toBeVisible();
    await expect(services.servicesLink).toHaveAttribute("aria-current", "page");
    await expect(services.agendaLink).not.toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 1, name: state.businessName })).toBeVisible();

    await services.agendaLink.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/$/);
    await expect(agenda.newAppointment).toBeVisible();
  });

  test("opening /servicios directly works, and without a session it goes to the login page", async ({
    page,
    browser,
    baseURL,
  }) => {
    const services = new ServicesPage(page);
    await services.open();
    await expect(services.rows.first()).toBeVisible();

    const anonymousContext = await browser.newContext({ baseURL: baseURL as string, storageState: anonymous });
    try {
      const guest = await anonymousContext.newPage();
      await guest.goto("/servicios");
      await expect(guest).toHaveURL(/\/login$/);
    } finally {
      await anonymousContext.close();
    }
  });

  test("lists name, duration, price (es-CO) or `Sin precio`, and state, with the inactive services marked and last", async ({
    page,
    api,
  }) => {
    await api.createService("Lista Barba", 30, 25_000);
    await api.createService("Lista Cejas", 45);
    await api.createService("Lista Zeta", 60, 1_500_000);
    await api.createService("Lista Gratis", 15, 0);
    const oldId = await api.createService("Lista Antigua", 90, 8_000);
    await api.updateService(oldId, { active: false });
    const oldNoPriceId = await api.createService("Lista Vieja", 20);
    await api.updateService(oldNoPriceId, { active: false });

    const services = new ServicesPage(page);
    await services.open();

    const expectRow = async (name: string, duration: string, price: string, status: string) => {
      const row = services.row(name);
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId("service-duration")).toHaveText(duration);
      await expect(row.getByTestId("service-price")).toHaveText(price);
      await expect(row.getByTestId("service-status")).toHaveText(status);
    };
    await expectRow("Lista Barba", "30 min", "$25.000", "Activo");
    await expectRow("Lista Cejas", "45 min", "Sin precio", "Activo");
    await expectRow("Lista Zeta", "60 min", "$1.500.000", "Activo");
    await expectRow("Lista Gratis", "15 min", "$0", "Activo");
    await expectRow("Lista Antigua", "90 min", "$8.000", "Inactivo");
    await expectRow("Lista Vieja", "20 min", "Sin precio", "Inactivo");
    // The services of the seed (no price) are listed too.
    await expectRow("Corte", "30 min", "Sin precio", "Activo");

    // Every active row comes before every inactive row, and inactive rows are visibly marked.
    const statuses = await services.statuses();
    expect(statuses).toHaveLength((await api.services()).length);
    expect(statuses.lastIndexOf("Activo")).toBeLessThan(statuses.indexOf("Inactivo"));
    await expect(services.row("Lista Antigua")).toHaveAttribute("data-active", "false");
    await expect(services.row("Lista Vieja")).toHaveAttribute("data-active", "false");
    await expect(services.row("Lista Barba")).toHaveAttribute("data-active", "true");
  });
});

test.describe("create", () => {
  test("with a price: the dialog closes, the list shows it and the API has it", async ({ page, api }) => {
    const services = new ServicesPage(page);
    const dialog = new ServiceDialog(page);
    const posts = countRequests(page, "POST", /^\/api\/services$/);
    await services.open();

    await services.newService.click();
    await expect(dialog.root).toBeVisible();
    await expect(dialog.name).toBeFocused();
    await expect(dialog.active).toHaveCount(0); // a new service is always active
    await dialog.fill({ name: "Crea Con Precio", duration: "40", price: "35000" });
    await dialog.create.click();

    await expect(dialog.root).toBeHidden();
    await expect(services.newService).toBeFocused();
    const row = services.row("Crea Con Precio");
    await expect(row.getByTestId("service-duration")).toHaveText("40 min");
    await expect(row.getByTestId("service-price")).toHaveText("$35.000");
    await expect(row.getByTestId("service-status")).toHaveText("Activo");
    expect(posts.bodies()).toEqual([{ name: "Crea Con Precio", durationMinutes: 40, price: 35_000 }]);
    expect(await api.service("Crea Con Precio")).toMatchObject({ durationMinutes: 40, price: 35_000, active: true });
  });

  test("without a price: an empty field means no price", async ({ page, api }) => {
    const services = new ServicesPage(page);
    const dialog = new ServiceDialog(page);
    await services.open();

    await services.newService.click();
    await dialog.fill({ name: "  Crea Sin Precio  ", duration: "25" });
    await dialog.create.click();

    await expect(dialog.root).toBeHidden();
    const row = services.row("Crea Sin Precio");
    await expect(row.getByTestId("service-price")).toHaveText("Sin precio");
    await expect(row.getByTestId("service-duration")).toHaveText("25 min");
    expect(await api.service("Crea Sin Precio")).toMatchObject({ durationMinutes: 25, price: null, active: true });
  });

  test("validation: messages announced as alerts, nothing sent, and the dialog keeps the input", async ({ page, api }) => {
    const services = new ServicesPage(page);
    const dialog = new ServiceDialog(page);
    const writes = countRequests(page, "POST", /^\/api\/services$/);
    const before = (await api.services()).length;
    await services.open();
    await services.newService.click();

    // Empty form: name and duration are required, the price is not.
    await dialog.create.click();
    await expect(dialog.alerts).toHaveText([NAME_REQUIRED, DURATION_INVALID]);
    await expect(dialog.name).toBeFocused();
    await expect(dialog.name).toHaveAttribute("aria-invalid", "true");

    await dialog.fill({ name: "   ", duration: "0" });
    await dialog.create.click();
    await expect(dialog.alerts).toHaveText([NAME_REQUIRED, DURATION_INVALID]);

    await dialog.fill({ name: "Valida", duration: "1441" });
    await dialog.create.click();
    await expect(dialog.alerts).toHaveText(DURATION_INVALID);
    for (const duration of ["-5", "30.5", "abc"]) {
      await dialog.duration.fill(duration);
      await dialog.create.click();
      await expect(dialog.alerts).toHaveText(DURATION_INVALID);
    }

    // The price: whole pesos only.
    await dialog.duration.fill("30");
    for (const [price, message] of [
      ["-5", PRICE_INVALID],
      ["12.5", PRICE_INVALID],
      ["12,5", PRICE_INVALID],
      ["abc", PRICE_INVALID],
      ["100000001", PRICE_TOO_HIGH],
    ] as const) {
      await dialog.price.fill(price);
      await dialog.create.click();
      await expect(dialog.alerts).toHaveText(message);
      await expect(dialog.price).toHaveAttribute("aria-invalid", "true");
    }

    await expect(dialog.root).toBeVisible();
    await expect(dialog.name).toHaveValue("Valida");
    await expect(dialog.duration).toHaveValue("30");
    expect(writes.count()).toBe(0);
    expect((await api.services()).length).toBe(before);

    // Fixing the input clears the messages and the request goes through (0 is a valid price).
    await dialog.price.fill("0");
    await dialog.create.click();
    await expect(dialog.root).toBeHidden();
    await expect(services.row("Valida").getByTestId("service-price")).toHaveText("$0");
    expect(writes.count()).toBe(1);
  });
});

test.describe("edit", () => {
  test("the dialog starts with the current values; changing the price updates the list and the API", async ({
    page,
    api,
  }) => {
    const id = await api.createService("Edita Precio", 30, 20_000);
    const services = new ServicesPage(page);
    const dialog = new ServiceDialog(page);
    const patches = countRequests(page, "PATCH", /^\/api\/services\/[^/]+$/);
    await services.open();

    await services.edit("Edita Precio").click();
    await expect(dialog.root).toBeVisible();
    await expect(dialog.root.getByRole("heading", { name: "Editar servicio" })).toBeVisible();
    await expect(dialog.name).toHaveValue("Edita Precio");
    await expect(dialog.duration).toHaveValue("30");
    await expect(dialog.price).toHaveValue("20000");
    await expect(dialog.active).toBeChecked();

    await dialog.price.fill("27500");
    await dialog.save.click();

    await expect(dialog.root).toBeHidden();
    await expect(services.edit("Edita Precio")).toBeFocused();
    await expect(services.row("Edita Precio").getByTestId("service-price")).toHaveText("$27.500");
    expect(patches.bodies()).toEqual([{ name: "Edita Precio", durationMinutes: 30, price: 27_500, active: true }]);
    expect(await api.service("Edita Precio")).toMatchObject({ id, price: 27_500, active: true });
  });

  test("name and duration can change too, and the edit validates like the creation", async ({ page, api }) => {
    await api.createService("Edita Todo", 30, 5_000);
    const services = new ServicesPage(page);
    const dialog = new ServiceDialog(page);
    await services.open();

    await services.edit("Edita Todo").click();
    await dialog.fill({ name: "", duration: "0", price: "-1" });
    await dialog.save.click();
    await expect(dialog.alerts).toHaveText([NAME_REQUIRED, DURATION_INVALID, PRICE_INVALID]);

    await dialog.fill({ name: "Edita Todo Nuevo", duration: "75", price: "6000" });
    await dialog.save.click();
    await expect(dialog.root).toBeHidden();
    const row = services.row("Edita Todo Nuevo");
    await expect(row.getByTestId("service-duration")).toHaveText("75 min");
    await expect(row.getByTestId("service-price")).toHaveText("$6.000");
    await expect(services.row("Edita Todo")).toHaveCount(1); // only the renamed one matches (prefix)
    expect(await api.service("Edita Todo")).toBeUndefined();
    expect(await api.service("Edita Todo Nuevo")).toMatchObject({ durationMinutes: 75, price: 6_000 });
  });

  test("clearing the price sends null and the list shows `Sin precio`", async ({ page, api }) => {
    await api.createService("Edita Quita", 30, 12_000);
    const services = new ServicesPage(page);
    const dialog = new ServiceDialog(page);
    const patches = countRequests(page, "PATCH", /^\/api\/services\/[^/]+$/);
    await services.open();

    await services.edit("Edita Quita").click();
    await dialog.price.fill("");
    await dialog.save.click();

    await expect(dialog.root).toBeHidden();
    await expect(services.row("Edita Quita").getByTestId("service-price")).toHaveText("Sin precio");
    expect(patches.bodies()).toEqual([{ name: "Edita Quita", durationMinutes: 30, price: null, active: true }]);
    expect(await api.service("Edita Quita")).toMatchObject({ price: null });
  });
});

test.describe("deactivate and reactivate", () => {
  test("a deactivated service leaves the booking picker and goes last; reactivating brings it back", async ({
    page,
    agenda,
    api,
  }) => {
    await api.createService("Activa Temporal", 20, 9_000);
    const services = new ServicesPage(page);
    const dialog = new ServiceDialog(page);
    const booking = new BookingDialog(page);
    const option = (name: string) => page.getByRole("option", { name });
    await services.open();
    await expect(services.row("Activa Temporal").getByTestId("service-status")).toHaveText("Activo");

    // Deactivate with the switch of the edit dialog.
    await services.edit("Activa Temporal").click();
    await dialog.active.click();
    await expect(dialog.active).not.toBeChecked();
    await dialog.save.click();
    await expect(dialog.root).toBeHidden();
    const row = services.row("Activa Temporal");
    await expect(row.getByTestId("service-status")).toHaveText("Inactivo");
    await expect(row).toHaveAttribute("data-active", "false");
    const statuses = await services.statuses();
    expect(statuses.lastIndexOf("Activo")).toBeLessThan(statuses.indexOf("Inactivo"));
    expect(await api.service("Activa Temporal")).toMatchObject({ active: false, price: 9_000 });

    // The booking dialog (same SPA session, so the cache was invalidated by the edit) does not offer it.
    await services.agendaLink.click();
    await agenda.newAppointment.click();
    await booking.service.click();
    await expect(option("Corte")).toBeVisible();
    await expect(option("Activa Temporal")).toHaveCount(0);
    await page.keyboard.press("Escape"); // closes the list
    await page.keyboard.press("Escape"); // closes the dialog
    await expect(booking.root).toBeHidden();

    // Reactivate.
    await services.servicesLink.click();
    await services.edit("Activa Temporal").click();
    await expect(dialog.active).not.toBeChecked();
    await dialog.active.click();
    await dialog.save.click();
    await expect(dialog.root).toBeHidden();
    await expect(row.getByTestId("service-status")).toHaveText("Activo");
    await expect(row).toHaveAttribute("data-active", "true");
    expect(await api.service("Activa Temporal")).toMatchObject({ active: true });

    await services.agendaLink.click();
    await agenda.newAppointment.click();
    await booking.service.click();
    await expect(option("Activa Temporal · $9.000")).toBeVisible();
  });
});

test.describe("booking dialog", () => {
  test("shows only active services and the price next to each option that has one", async ({ page, agenda, state, api }) => {
    await api.createService("Reserva Con Precio", 30, 18_000);
    const hiddenId = await api.createService("Reserva Oculta", 30, 4_000);
    await api.updateService(hiddenId, { active: false });
    const booking = new BookingDialog(page);
    await agenda.open(state);
    await agenda.newAppointment.click();
    await booking.service.click();

    await expect(page.getByRole("option", { name: "Reserva Con Precio · $18.000", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "Corte", exact: true })).toBeVisible(); // no price, no suffix
    await expect(page.getByRole("option", { name: "Reserva Oculta" })).toHaveCount(0);

    await page.getByRole("option", { name: "Reserva Con Precio" }).click();
    await expect(booking.service).toHaveText("Reserva Con Precio · $18.000");
    await booking.fill({ phone: "573005559001", date: "2099-01-05", time: "08:00" });
    await expect(booking.endTime).toHaveText("Termina a las 08:30");
  });

  test("the inline \"Nuevo servicio\" form has an optional price, validated as whole pesos", async ({ page, agenda, state }) => {
    const booking = new BookingDialog(page);
    const posts = countRequests(page, "POST", /^\/api\/services$/);
    // Pretend the business has no services until one is created through the inline form.
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

    const price = booking.root.getByLabel("Precio (opcional)");
    await booking.newService.name.fill("Inline Con Precio");
    await booking.newService.duration.fill("45");
    for (const invalid of ["-1", "9.5"]) {
      await price.fill(invalid);
      await booking.newService.submit.click();
      await expect(booking.alerts).toHaveText(PRICE_INVALID);
    }
    expect(posts.count()).toBe(0);

    await price.fill("12000");
    await booking.newService.submit.click();
    await expect(booking.newService.heading).toBeHidden();
    await expect(booking.service).toHaveText("Inline Con Precio · $12.000");
    expect(posts.bodies()).toEqual([{ name: "Inline Con Precio", durationMinutes: 45, price: 12_000 }]);
  });
});

test.describe("detail dialog", () => {
  test("shows the price of the service when it has one, and no price row when it has none", async ({
    page,
    agenda,
    state,
    api,
  }) => {
    await api.createService("Detalle Con Precio", 30, 42_000);
    await api.createService("Detalle Sin Precio", 30);
    // 06:00 and 06:30 today: hours no other spec books.
    await api.book("Detalle Con Precio", state.dates.today, "06:00", "573005559101", "Dani Detalle");
    await api.book("Detalle Sin Precio", state.dates.today, "06:30", "573005559102", "Nico Detalle");
    const detail = new DetailDialog(page);
    await agenda.open(state);

    await agenda.block("Dani Detalle").click();
    await expect(detail.root.getByTestId("detail-price")).toHaveText("$42.000");
    await expect(detail.root.getByText("Precio", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(detail.root).toBeHidden();

    await agenda.block("Nico Detalle").click();
    await expect(detail.root.getByRole("heading", { name: "Nico Detalle" })).toBeVisible();
    await expect(detail.root.getByTestId("detail-price")).toHaveCount(0);
    await expect(detail.root.getByText("Precio", { exact: true })).toHaveCount(0);
  });
});

test.describe("server errors", () => {
  test("a 500 on create shows the generic message and keeps the dialog and the input; a retry then succeeds", async ({
    page,
    api,
  }) => {
    const services = new ServicesPage(page);
    const dialog = new ServiceDialog(page);
    await services.open();
    await page.route("**/api/services", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"internal"}' })
        : route.continue(),
    );

    await services.newService.click();
    await dialog.fill({ name: "Falla Crear", duration: "30", price: "11000" });
    await dialog.create.click();

    await expect(dialog.alerts).toHaveText(GENERIC_ERROR);
    await expect(dialog.root).toBeVisible();
    await expect(dialog.create).toBeEnabled();
    await expect(dialog.name).toHaveValue("Falla Crear");
    await expect(dialog.duration).toHaveValue("30");
    await expect(dialog.price).toHaveValue("11000");
    await expect(services.row("Falla Crear")).toHaveCount(0);
    expect(await api.service("Falla Crear")).toBeUndefined();

    await page.unroute("**/api/services");
    await dialog.create.click();
    await expect(dialog.root).toBeHidden();
    await expect(services.row("Falla Crear").getByTestId("service-price")).toHaveText("$11.000");
  });

  test("a 500 on edit shows the generic message, keeps the dialog and the input, and leaves the data unchanged", async ({
    page,
    api,
  }) => {
    await api.createService("Falla Editar", 30, 3_000);
    const services = new ServicesPage(page);
    const dialog = new ServiceDialog(page);
    await services.open();
    await page.route(/\/api\/services\/[^/]+$/, (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"internal"}' })
        : route.continue(),
    );

    await services.edit("Falla Editar").click();
    await dialog.price.fill("4000");
    await dialog.active.click();
    await dialog.save.click();

    await expect(dialog.alerts).toHaveText(GENERIC_ERROR);
    await expect(dialog.root).toBeVisible();
    await expect(dialog.price).toHaveValue("4000");
    await expect(dialog.active).not.toBeChecked();
    await expect(services.row("Falla Editar").getByTestId("service-price")).toHaveText("$3.000");
    await expect(services.row("Falla Editar").getByTestId("service-status")).toHaveText("Activo");
    expect(await api.service("Falla Editar")).toMatchObject({ price: 3_000, active: true });
  });

  test("a 404 on edit (the service is gone) says so, keeps the dialog and refreshes the list", async ({ page, api }) => {
    await api.createService("Falla Perdido", 30, 3_000);
    const services = new ServicesPage(page);
    const dialog = new ServiceDialog(page);
    await services.open();
    const lists = countRequests(page, "GET", /^\/api\/services$/);
    await page.route(/\/api\/services\/[^/]+$/, (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not_found"}' })
        : route.continue(),
    );

    await services.edit("Falla Perdido").click();
    await dialog.price.fill("5000");
    await dialog.save.click();

    await expect(dialog.alerts).toHaveText(NOT_FOUND);
    await expect(dialog.root).toBeVisible();
    await expect(dialog.price).toHaveValue("5000");
    await expect.poll(() => lists.count()).toBeGreaterThanOrEqual(1);
  });
});

test.describe("keyboard and focus", () => {
  /** Labels of the distinct controls reached by Tab, until `Cerrar`. */
  async function tabOrder(page: Page): Promise<string[]> {
    const order: string[] = [];
    for (let presses = 0; presses < 20 && !order.includes("Cerrar"); presses += 1) {
      await page.keyboard.press("Tab");
      const label = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        const labelled = (element as HTMLInputElement | null)?.labels?.[0]?.textContent;
        return (labelled ?? element?.getAttribute("aria-label") ?? element?.textContent ?? "").trim();
      });
      if (order.at(-1) !== label) order.push(label);
    }
    return order;
  }

  test("the create dialog opens with Enter, Tab stays inside in a sensible order, Escape closes and returns focus", async ({
    page,
  }) => {
    const services = new ServicesPage(page);
    const dialog = new ServiceDialog(page);
    await services.open();

    await services.newService.focus();
    await page.keyboard.press("Enter");
    await expect(dialog.root).toBeVisible();
    await expect(dialog.name).toBeFocused();

    expect(await tabOrder(page)).toEqual([
      "Duración (minutos)",
      "Precio (opcional)",
      "Cancelar",
      "Crear servicio",
      "Cerrar",
    ]);
    await page.keyboard.press("Tab");
    await expect(dialog.name).toBeFocused(); // trapped

    await page.keyboard.press("Escape");
    await expect(dialog.root).toBeHidden();
    await expect(services.newService).toBeFocused();
  });

  test("the edit dialog has the Activo switch in its order, Space toggles it, Escape returns focus to the row's button", async ({
    page,
    api,
  }) => {
    await api.createService("Teclado Edita", 30, 2_000);
    const services = new ServicesPage(page);
    const dialog = new ServiceDialog(page);
    await services.open();

    await services.edit("Teclado Edita").focus();
    await page.keyboard.press("Enter");
    await expect(dialog.root).toBeVisible();
    await expect(dialog.name).toBeFocused();

    expect(await tabOrder(page)).toEqual([
      "Duración (minutos)",
      "Precio (opcional)",
      "Activo",
      "Cancelar",
      "Guardar cambios",
      "Cerrar",
    ]);
    await dialog.active.focus();
    await page.keyboard.press("Space");
    await expect(dialog.active).not.toBeChecked();
    await page.keyboard.press("Space");
    await expect(dialog.active).toBeChecked();

    await page.keyboard.press("Escape");
    await expect(dialog.root).toBeHidden();
    await expect(services.edit("Teclado Edita")).toBeFocused();
    expect(await api.service("Teclado Edita")).toMatchObject({ active: true }); // nothing was saved
  });
});

test.describe("375px viewport", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("the list, the create dialog and the edit dialog fit without horizontal overflow, with 40px targets", async ({
    page,
    api,
  }) => {
    await api.createService(
      "Servicio con un nombre larguísimo para comprobar que no desborda en pantallas pequeñas ni empuja el precio",
      30,
      1_500_000,
    );
    const inactiveId = await api.createService("Móvil Inactivo", 30, 8_000);
    await api.updateService(inactiveId, { active: false });
    const services = new ServicesPage(page);
    const dialog = new ServiceDialog(page);
    await services.open();
    await expect(services.rows.first()).toBeVisible();

    await expectNoPageOverflow(page);
    await expectTouchTargets([services.servicesLink, services.agendaLink, services.newService]);
    const editButtons = page.getByRole("button", { name: /^Editar / });
    const total = await editButtons.count();
    expect(total).toBeGreaterThanOrEqual(3);
    await expectTouchTargets(await Promise.all(Array.from({ length: total }, (_, index) => editButtons.nth(index))));

    await services.newService.click();
    await settled(dialog.root);
    await expectDialogFits(page, dialog.root, 375);
    await expectTouchTargets([dialog.name, dialog.duration, dialog.price, dialog.cancel, dialog.create, dialog.close]);
    await dialog.create.click();
    await expect(dialog.alerts.first()).toBeVisible();
    await dialog.fill({ price: "abc" });
    await dialog.create.click();
    await expectDialogFits(page, dialog.root, 375);
    await page.keyboard.press("Escape");
    await expect(dialog.root).toBeHidden();

    await services.edit("Móvil Inactivo").click();
    await expect(dialog.active).not.toBeChecked();
    await expectDialogFits(page, dialog.root, 375);
    await expectTouchTargets([dialog.name, dialog.duration, dialog.price, dialog.activeRow, dialog.cancel, dialog.save, dialog.close]);
    // Tapping the label toggles the switch, so the whole row is the touch target.
    await dialog.activeRow.click();
    await expect(dialog.active).toBeChecked();
  });
});

test.describe("two owners", () => {
  test.use({ storageState: anonymous });

  test("owner B never sees owner A's services after signing out and in again without a reload", async ({
    page,
    agenda,
    state,
  }) => {
    test.setTimeout(60_000); // two form sign-ins may have to wait for the rate-limit window
    const services = new ServicesPage(page);
    const dialog = new ServiceDialog(page);

    await agenda.login(state);
    await services.servicesLink.click();
    await services.newService.click();
    await dialog.fill({ name: "Solo De A", duration: "30", price: "9900" });
    await dialog.create.click();
    await expect(dialog.root).toBeHidden();
    await expect(services.row("Solo De A").getByTestId("service-price")).toHaveText("$9.900");
    await expect(services.row("Corte")).toHaveCount(1);

    // Sign out from the services screen; no reload from here on, so the query cache would survive if it were kept.
    await agenda.logout.click();
    await expect(page).toHaveURL(/\/login$/);
    await agenda.signInFromForm(state.ownerB);

    await services.servicesLink.click();
    await expect(services.heading).toBeVisible();
    await expect(services.row("Manicure").getByTestId("service-duration")).toHaveText("45 min");
    await expect(services.rows).toHaveCount(1);
    for (const name of ["Solo De A", "Corte", "Tinte"]) await expect(services.row(name)).toHaveCount(0);

    // A late refetch must not bring A's services back either.
    await page.waitForTimeout(1_500);
    await expect(services.rows).toHaveCount(1);
    await expect(page.getByText("Solo De A")).toHaveCount(0);
  });
});
