import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import base from "../playwright.config";

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: "docs-capture.spec.ts",
  testIgnore: [],
  timeout: 90000,
  use: { ...base.use, baseURL: "http://127.0.0.1:8080" },
  webServer: {
    command: "node tests/start.mjs",
    cwd: resolve(import.meta.dirname, ".."),
    url: "http://127.0.0.1:8080/healthz",
    timeout: 120000,
    reuseExistingServer: false,
  },
});
