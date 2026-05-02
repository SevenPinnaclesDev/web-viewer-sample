/*
 * Vitest global setup — Day 2 fix.
 *
 * @testing-library/react does NOT auto-cleanup between tests under vitest
 * unless globals are enabled or this setup runs cleanup() in an afterEach.
 * Without it, every render() leaks DOM into the next test, which is why
 * Day 1's tests pass individually but fail in batch with "found multiple
 * elements by data-testid".
 *
 * Documented behavior: https://testing-library.com/docs/react-testing-library/api/#cleanup
 *
 * Ryan Takeda — Phase 1 Day 2, 2026-05-01.
 */
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

afterEach(() => {
    cleanup();
});
