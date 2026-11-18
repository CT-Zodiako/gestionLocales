import { expect, test as base, type Locator, type Page } from "@playwright/test";
import { readState, type E2eState } from "./seed.ts";

type Credentials = { email: string; password: string; businessName: string };

/** Page object for the agenda shell. Selectors are roles, labels and a few test ids for geometry. */
export class AgendaPage {
  readonly page: Page;
  readonly previous: Locator;
  readonly next: Locator;
  readonly todayButton: Locator;
  readonly dayToggle: Locator;
  readonly weekToggle: Locator;
  readonly cancelledToggle: Locator;
  readonly rangeLabel: Locator;
  readonly logout: Locator;

  constructor(page: Page) {
    this.page = page;
    this.previous = page.getByRole("button", { name: "Anterior" });
    this.next = page.getByRole("button", { name: "Siguiente" });
    this.todayButton = page.getByRole("button", { name: "Hoy" });
    this.dayToggle = page.getByRole("radio", { name: "Día" });
    this.weekToggle = page.getByRole("radio", { name: "Semana" });
    this.cancelledToggle = page.getByRole("button", { name: "Canceladas" });
    this.rangeLabel = page.getByTestId("range-label");
    this.logout = page.getByRole("button", { name: "Cerrar sesión" });
  }

  /** Opens the agenda with the pre-made session of the seeded owner (no sign-in request). */
  async open(state: E2eState): Promise<void> {
    await this.page.goto("/");
    await expect(this.page.getByRole("heading", { level: 1, name: state.businessName })).toBeVisible();
  }

  /** Opens the login page and signs in through the form. */
  async login(owner: Credentials): Promise<void> {
    await this.page.goto("/login");
    await this.signInFromForm(owner);
  }

  /**
   * Fills and submits the login form on the current page (no reload, so the SPA keeps its state).
   * Better Auth rate-limits sign-ins (3 per 10 s); on a 429 it waits for the window and submits again.
   */
  async signInFromForm(owner: Credentials): Promise<void> {
    await this.page.getByLabel("Correo").fill(owner.email);
    await this.page.getByLabel("Contraseña").fill(owner.password);
    for (let attempt = 1; ; attempt += 1) {
      const response = this.page.waitForResponse((res) => res.url().includes("/api/auth/sign-in/email"));
      await this.page.getByRole("button", { name: "Entrar" }).click();
      const { status, retryAfter } = await response.then((res) => ({
        status: res.status(),
        retryAfter: Number(res.headers()["x-retry-after"] ?? 10),
      }));
      if (status !== 429 || attempt >= 3) break;
      await this.page.waitForTimeout((retryAfter + 0.5) * 1000);
    }
    await expect(this.page.getByRole("heading", { level: 1, name: owner.businessName })).toBeVisible();
  }

  blocks(scope: Page | Locator = this.page): Locator {
    return scope.getByTestId("appointment-block");
  }

  block(name: string, scope: Page | Locator = this.page): Locator {
    return this.blocks(scope).filter({ hasText: name });
  }

  /** The column of a date in the week view. */
  column(date: string): Locator {
    return this.page.getByTestId(`day-${date}`);
  }

  /** The row of an hour (`09`) in the day view time grid. */
  hourRow(hour: string): Locator {
    return this.page.getByTestId(`hour-${hour}`);
  }
}

type Fixtures = {
  state: E2eState;
  agenda: AgendaPage;
  consoleErrors: string[];
};

/** Context without cookies, for the specs that sign in through the form. */
export const anonymous = { cookies: [], origins: [] };

export const test = base.extend<Fixtures>({
  // Every spec starts signed in as the seeded owner unless it overrides this with `anonymous`.
  // eslint-disable-next-line no-empty-pattern
  storageState: async ({}, use) => {
    await use(readState().storageStatePath);
  },
  // eslint-disable-next-line no-empty-pattern
  state: async ({}, use) => {
    await use(readState());
  },
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      // A 429 on sign-in is Better Auth's rate limit (3 per 10 s) shared with other runs, not an app error;
      // AgendaPage.signInFromForm waits it out and submits again.
      const rateLimitedSignIn =
        message.location().url.includes("/api/auth/sign-in/email") && message.text().includes("429");
      if (!rateLimitedSignIn) errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await use(errors);
  },
  agenda: async ({ page, consoleErrors: _consoleErrors }, use) => {
    await use(new AgendaPage(page));
  },
});

export { expect };
