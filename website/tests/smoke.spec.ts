import { expect, test } from "@playwright/test";

test("says what Friday is on the first screen", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/");
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toContainText("WhatsApp");
  await expect(heading).toBeInViewport({ ratio: 1 });
  await expect(page.locator(".hero").getByRole("link", { name: "Minta akses" })).toBeInViewport({ ratio: 1 });
  await expect(page.locator(".hero .bubble").first()).toBeInViewport();
});

test("the headline finishes its entrance", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(1200);
  const box = await page.locator(".hero h1 .line span").first().boundingBox();
  const mask = await page.locator(".hero h1 .line").first().boundingBox();
  expect(Math.abs(box!.y - mask!.y)).toBeLessThan(2);
});

test("loads without errors and never scrolls sideways", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/");
  await page.waitForTimeout(1000);
  await page.evaluate(() => scrollTo({ top: document.body.scrollHeight / 2, behavior: "instant" }));
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test("the access button opens WhatsApp with the sentence Friday recognises", async ({ page }) => {
  await page.goto("/");
  const href = await page.locator(".hero").getByRole("link", { name: "Minta akses" }).getAttribute("href");
  expect(href).toBe("https://wa.me/6281775741000?text=Halo%20Friday%2C%20aku%20mau%20coba");
});

test("links to the privacy policy, as Google's verification requires", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".footer a[href='/privacy']")).toHaveCount(1);
});

test("the day story plays through the scrollbar", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveClass(/motion/);
  await expect(page.locator(".story")).toHaveClass(/is-live/);
  await expect(page.locator(".story__phone .chat")).toHaveCount(7);
  await page.evaluate(() => {
    const track = document.querySelector<HTMLElement>(".story__track")!;
    const top = track.getBoundingClientRect().top + scrollY;
    scrollTo({ top: top + (track.offsetHeight - innerHeight) * 0.97, behavior: "instant" });
  });
  await expect(page.locator(".story__phone .phone__clock")).toHaveText("20.30");
  await expect(page.locator('.sky__layer[data-sky="malam"]')).toHaveCSS("opacity", "1");
  await expect(page.locator(".sticky-cta")).toBeHidden();
});

test("the last sentence is readable once the sky turns to morning", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveClass(/motion/);
  await page.evaluate(() => scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
  await expect(page.locator('.sky__layer[data-sky="fajar"]')).toHaveCSS("opacity", "1");
  await expect(page.locator(".final h2")).toHaveCSS("opacity", "1");
  await expect(page.locator(".final h2")).toBeInViewport();
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("every feature and scene is still readable", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".scene")).toHaveCount(7);
    await expect(page.locator(".scene__phone .chat")).toHaveCount(7);
    const titles = page.locator(".panel__title");
    expect(await titles.count()).toBeGreaterThanOrEqual(11);
    for (const panel of await page.locator(".panel").all()) await expect(panel).toBeVisible();
  });
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("shows the static page and working tabs", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: /Voice Note/ }).click();
    await expect(page.getByRole("tab", { name: /Voice Note/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#panel-friday-06")).toBeVisible();
    await expect(page.locator("html")).not.toHaveClass(/motion/);
    await expect(page.locator(".sky")).toBeHidden();
    await expect(page.locator(".story")).not.toHaveClass(/is-live/);
  });
});

test("the feature picker follows the keyboard", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop keyboards only");
  await page.goto("/");
  const first = page.getByRole("tab").first();
  await first.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("tab").nth(1)).toBeFocused();
  await expect(page.getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");
});
