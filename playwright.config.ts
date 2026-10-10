import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  testIgnore: "**/docs-capture.spec.ts",
  timeout: 45000,
  expect: { timeout: 15000 },
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.UI_ONLY
      ? "http://127.0.0.1:8081"
      : "http://127.0.0.1:8080",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
    permissions: ["camera", "microphone"],
  },
  webServer: {
    command: process.env.UI_ONLY
      ? "node tests/preview.mjs"
      : "node tests/start.mjs",
    url: process.env.UI_ONLY
      ? "http://127.0.0.1:8081"
      : "http://127.0.0.1:8080/healthz",
    timeout: 120000,
    reuseExistingServer: false,
  },
});
