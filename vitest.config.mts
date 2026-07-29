import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/.next/**", "**/node_modules/**", "**/dist/**", "**/coverage/**"],
  },
});
