import { defineConfig, devices } from "@playwright/test";

// Real-process federation E2E. A single worker owns one World writer, one real Node
// civilization, and one Chromium browser; the suite is intentionally serial because it
// asserts a shared, authoritative world ledger. Artifacts land under .artifacts/ (gitignored).
export default defineConfig({
  testDir: "./src",
  testMatch: /.*\.e2e\.spec\.ts/,
  outputDir: "./.artifacts/test-results",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // The end-to-end flow spawns processes, drives the protocol, and polls asynchronous world
  // processing, so it needs a generous ceiling; every wait inside is still deadline-bounded.
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["html", { outputFolder: "./.artifacts/report", open: "never" }]],
  use: {
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
