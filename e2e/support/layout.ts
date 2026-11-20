import { expect, type Locator, type Page } from "@playwright/test";

export const MIN_TOUCH_TARGET = 40;

/** Waits for a dialog's open animation (it scales in), so sizes are measured at rest. */
export async function settled(dialog: Locator): Promise<void> {
  await dialog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
}

/** Every control is rendered and at least 40 px tall. */
export async function expectTouchTargets(controls: Locator[]): Promise<void> {
  for (const control of controls) {
    const box = await control.boundingBox();
    expect(box, "control is rendered").toBeTruthy();
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET - 0.5);
  }
}

/** The page has no horizontal overflow. */
export async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/** The dialog has no horizontal overflow and sits inside the viewport. */
export async function expectDialogFits(page: Page, dialog: Locator, width: number): Promise<void> {
  await settled(dialog);
  await expectNoPageOverflow(page);
  expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
  const box = await dialog.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
}
