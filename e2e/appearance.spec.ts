import { expect, test } from "./support/fixtures.ts";

/** Normalises any CSS color (the app uses oklch) to sRGB through a canvas. */
async function rgbOf(locator: import("@playwright/test").Locator, property: "backgroundColor" | "color") {
  return locator.evaluate((el, prop) => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillStyle = getComputedStyle(el)[prop];
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b];
  }, property);
}

test.describe("appearance", () => {
  test("the main color is electric blue #1f6bff and the PWA theme color matches", async ({ page, request }) => {
    await page.goto("/login");
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#1f6bff");

    const href = await page.locator('link[rel="manifest"]').getAttribute("href");
    const manifest = (await (await request.get(href!)).json()) as { theme_color: string };
    expect(manifest.theme_color).toBe("#1f6bff");

    const [r, g, b] = await rgbOf(page.getByRole("button", { name: "Entrar" }), "backgroundColor");
    expect(Math.abs(r - 0x1f)).toBeLessThanOrEqual(4);
    expect(Math.abs(g - 0x6b)).toBeLessThanOrEqual(4);
    expect(Math.abs(b - 0xff)).toBeLessThanOrEqual(4);
  });
});
