import type { Locator, Page } from "@playwright/test";

/** The "Nueva cita" dialog, including its inline "Nuevo servicio" form. Controls are found by label and role. */
export class BookingDialog {
  readonly page: Page;
  readonly root: Locator;
  readonly phone: Locator;
  readonly name: Locator;
  readonly service: Locator;
  readonly date: Locator;
  readonly time: Locator;
  readonly endTime: Locator;
  readonly submit: Locator;
  readonly cancel: Locator;
  readonly alerts: Locator;
  readonly newService: {
    heading: Locator;
    name: Locator;
    duration: Locator;
    submit: Locator;
  };

  constructor(page: Page) {
    this.page = page;
    this.root = page.getByRole("dialog", { name: "Nueva cita" });
    this.phone = this.root.getByLabel("Teléfono del cliente");
    this.name = this.root.getByLabel("Nombre del cliente (opcional)");
    this.service = this.root.getByLabel("Servicio", { exact: true });
    this.date = this.root.getByLabel("Fecha", { exact: true });
    this.time = this.root.getByLabel("Hora", { exact: true });
    this.endTime = this.root.getByTestId("end-time");
    this.submit = this.root.getByRole("button", { name: "Agendar cita" });
    this.cancel = this.root.getByRole("button", { name: "Cancelar", exact: true });
    this.alerts = this.root.getByRole("alert");
    this.newService = {
      heading: this.root.getByRole("heading", { name: "Nuevo servicio" }),
      name: this.root.getByLabel("Nombre del servicio"),
      duration: this.root.getByLabel("Duración (minutos)"),
      submit: this.root.getByRole("button", { name: "Crear servicio" }),
    };
  }

  async chooseService(name: string): Promise<void> {
    await this.service.click();
    await this.page.getByRole("option", { name }).click();
  }

  async fill(values: { phone?: string; name?: string; service?: string; date?: string; time?: string }): Promise<void> {
    if (values.phone !== undefined) await this.phone.fill(values.phone);
    if (values.name !== undefined) await this.name.fill(values.name);
    if (values.service !== undefined) await this.chooseService(values.service);
    if (values.date !== undefined) await this.date.fill(values.date);
    if (values.time !== undefined) await this.time.fill(values.time);
  }
}

/** The detail dialog of an appointment, with its "Mover" form and the cancel confirmation. */
export class DetailDialog {
  readonly page: Page;
  readonly root: Locator;
  readonly move: Locator;
  readonly cancelAppointment: Locator;
  readonly confirmCancel: Locator;
  readonly keepAppointment: Locator;
  readonly date: Locator;
  readonly time: Locator;
  readonly endTime: Locator;
  readonly submitMove: Locator;
  readonly back: Locator;
  readonly alerts: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.getByRole("dialog");
    this.move = this.root.getByRole("button", { name: "Mover", exact: true });
    this.cancelAppointment = this.root.getByRole("button", { name: "Cancelar cita", exact: true });
    this.confirmCancel = this.root.getByRole("button", { name: "Sí, cancelar cita" });
    this.keepAppointment = this.root.getByRole("button", { name: "No, volver" });
    this.date = this.root.getByLabel("Fecha", { exact: true });
    this.time = this.root.getByLabel("Hora", { exact: true });
    this.endTime = this.root.getByTestId("end-time");
    this.submitMove = this.root.getByRole("button", { name: "Mover cita" });
    this.back = this.root.getByRole("button", { name: "Volver", exact: true });
    this.alerts = this.root.getByRole("alert");
  }
}
