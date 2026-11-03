import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "tests/rust-e2e", workers: 1, timeout: 90_000, use: { actionTimeout: 15_000 }, reporter: "list" });
