import { expect, test } from "./support/fixtures.ts";

type Manifest = {
  name: string;
  short_name: string;
  display: string;
  start_url: string;
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
};

/** Width and height from the IHDR chunk of a PNG. */
function pngSize(png: Buffer): { width: number; height: number } {
  expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test.describe("pwa", () => {
  test("the manifest is linked, served as JSON and has the required fields and icons", async ({ page, request }) => {
    await page.goto("/login");
    const href = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(href).toBeTruthy();

    const res = await request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("json");
    const manifest = (await res.json()) as Manifest;

    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{3,8}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{3,8}$/i);

    const sizes = manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose ?? "any"}`);
    expect(sizes).toEqual(expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]));
    for (const icon of manifest.icons) {
      const iconRes = await request.get(icon.src);
      expect(iconRes.status()).toBe(200);
      expect(iconRes.headers()["content-type"]).toContain("image/png");
      const [width] = icon.sizes.split("x").map(Number);
      expect(pngSize(await iconRes.body())).toEqual({ width, height: width });
    }
  });

  test("a service worker registers on the built app and is never cached by the browser", async ({ page, request }) => {
    await page.goto("/login");
    const scriptUrl = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.active?.scriptURL ?? null;
    });
    expect(scriptUrl).toMatch(/\/sw\.js$/);

    const sw = await request.get("/sw.js");
    expect(sw.status()).toBe(200);
    expect(sw.headers()["cache-control"]).toContain("no-cache");
  });

  test("offline reload serves the shell, but /api is not served from any cache", async ({ page, context }) => {
    await page.goto("/login");
    await page.evaluate(() => navigator.serviceWorker.ready);
    // Reload once so the page is controlled by the worker.
    await page.reload();
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    // Prime the API with a request while online, so a caching bug would have something to serve.
    const online = await page.evaluate(async () => (await fetch("/api/health")).status);
    expect(online).toBe(200);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Iniciar sesión" })).toBeVisible();

    const apiResult = await page.evaluate(() =>
      fetch("/api/health").then(
        (res) => `served:${res.status}`,
        () => "failed",
      ),
    );
    expect(apiResult).toBe("failed");

    const cachedUrls = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
      }
      return urls;
    });
    expect(cachedUrls.length).toBeGreaterThan(0);
    expect(cachedUrls.filter((path) => path.startsWith("/api"))).toEqual([]);
    await context.setOffline(false);
  });
});
