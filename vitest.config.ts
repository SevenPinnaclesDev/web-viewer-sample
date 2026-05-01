/*
 * Vitest config — Phase 1 Day 1 SPA component + service tests.
 *
 * jsdom environment for DOM-dependent component tests; node for service.
 * Tests live alongside source under __tests__/.
 *
 * Run: `npm run test` or `npx vitest run`.
 */
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    test: {
        environment: "jsdom",
        globals: false,
        include: ["src/**/__tests__/*.{test,spec}.{ts,tsx}"],
        setupFiles: [],
    },
});
