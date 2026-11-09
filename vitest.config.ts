import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so unit tests run in plain Node, without the
// Cloudflare plugin. D1 is replaced by an in-memory SQLite shim (test/d1.ts).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
