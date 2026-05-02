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
        // Day 2 fix: cleanup between tests so renders don't accumulate.
        // The setup file calls @testing-library/react's cleanup() in
        // afterEach. Without this, Day 1's tests pass alone but fail
        // in batch (multiple data-testid matches in the leaked DOM from
        // the prior test's render). The include pattern above only matches
        // *.test.* / *.spec.* under __tests__/, so setup.ts is naturally
        // out of the test-discovery glob.
        setupFiles: ["./src/__tests__/setup.ts"],
    },
});
