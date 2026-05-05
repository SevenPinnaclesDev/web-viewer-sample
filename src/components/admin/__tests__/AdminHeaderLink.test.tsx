/*
 * AdminHeaderLink tests — verify role gating.
 *
 * Ryan Takeda — admin pages wave-2, 2026-05-04.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { AdminHeaderLink } from "../AdminHeaderLink";


describe("AdminHeaderLink", () => {
    it("renders the link when user.role === 'admin'", () => {
        render(
            <AdminHeaderLink
                user={{ email: "x@x", role: "admin", display_name: "x", user_id: "u-1" }}
            />,
        );
        const link = screen.getByTestId("admin-header-link");
        expect(link).toBeInTheDocument();
        expect(link).toHaveAttribute("href", "/admin");
    });

    it("renders nothing when user.role === 'user'", () => {
        const { container } = render(
            <AdminHeaderLink
                user={{ email: "x@x", role: "user", display_name: "x", user_id: "u-1" }}
            />,
        );
        expect(container.firstChild).toBeNull();
    });
});
