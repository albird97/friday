import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  use: { baseURL: "http://localhost:4322" },
  webServer: { command: "npx astro preview --port 4322", port: 4322, reuseExistingServer: true },
  projects: [
    { name: "android", use: devices["Pixel 7"] },
    { name: "iphone", use: devices["iPhone 14"] },
    { name: "desktop", use: devices["Desktop Chrome"] },
  ],
});
