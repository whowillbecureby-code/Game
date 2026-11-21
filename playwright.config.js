const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.js",
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:4173",
    env: { PORT: "4173" },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
});
