import type { Locator, Page } from "@playwright/test";

/** The "Servicios" screen (`/servicios`): its list, the header links and the buttons that open the dialog. */
export class ServicesPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly rows: Locator;
  readonly newService: Locator;
  readonly servicesLink: Locator;
  readonly agendaLink: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { level: 2, name: "Servicios" });
    this.rows = page.getByTestId("service-row");
    this.newService = page.getByRole("button", { name: "Nuevo servicio", exact: true });
    this.servicesLink = page.getByRole("link", { name: "Servicios", exact: true });
    this.agendaLink = page.getByRole("link", { name: "Agenda", exact: true });
  }

  async open(): Promise<void> {
    await this.page.goto("/servicios");
    await this.heading.waitFor();
  }

  /** The row of a service; names used by the specs are never a prefix of one another. */
  row(name: string): Locator {
    return this.rows.filter({ has: this.page.getByTestId("service-name").filter({ hasText: name }) });
  }

  edit(name: string): Locator {
    return this.page.getByRole("button", { name: `Editar ${name}`, exact: true });
  }

  /** `Activo` / `Inactivo` of every row, in the order of the list. */
  async statuses(): Promise<string[]> {
    return this.page.getByTestId("service-status").allInnerTexts();
  }
}

/** The create/edit dialog of a service. */
export class ServiceDialog {
  readonly root: Locator;
  readonly name: Locator;
  readonly duration: Locator;
  readonly price: Locator;
  readonly active: Locator;
  readonly activeRow: Locator;
  readonly create: Locator;
  readonly save: Locator;
  readonly cancel: Locator;
  readonly close: Locator;
  readonly alerts: Locator;

  constructor(page: Page) {
    this.root = page.getByRole("dialog", { name: /^(Nuevo servicio|Editar servicio)$/ });
    this.name = this.root.getByLabel("Nombre del servicio");
    this.duration = this.root.getByLabel("Duración (minutos)");
    this.price = this.root.getByLabel("Precio (opcional)");
    this.active = this.root.getByRole("switch", { name: "Activo" });
    this.activeRow = this.root.locator("label", { hasText: "Activo" });
    this.create = this.root.getByRole("button", { name: "Crear servicio" });
    this.save = this.root.getByRole("button", { name: "Guardar cambios" });
    this.cancel = this.root.getByRole("button", { name: "Cancelar", exact: true });
    this.close = this.root.getByRole("button", { name: "Cerrar" });
    this.alerts = this.root.getByRole("alert");
  }

  async fill(values: { name?: string; duration?: string; price?: string }): Promise<void> {
    if (values.name !== undefined) await this.name.fill(values.name);
    if (values.duration !== undefined) await this.duration.fill(values.duration);
    if (values.price !== undefined) await this.price.fill(values.price);
  }
}
