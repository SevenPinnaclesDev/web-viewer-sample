/*
 * InviteForm tests — drive the modal through React Testing Library +
 * stub fetch. Cover client-side validation, submit success (email
 * sent + email failed), submit error, and copy-to-clipboard.
 *
 * Ryan Takeda — admin pages wave-2, 2026-05-04.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { InviteForm } from "../InviteForm";


function makeResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? "OK" : "Error",
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    } as unknown as Response;
}


describe("InviteForm", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders the empty form with email + role + submit", () => {
        const onClose = vi.fn();
        render(<InviteForm onClose={onClose} />);
        expect(screen.getByTestId("invite-form")).toBeInTheDocument();
        expect(screen.getByTestId("invite-form-email")).toBeInTheDocument();
        expect(screen.getByTestId("invite-form-role")).toBeInTheDocument();
        expect(screen.getByTestId("invite-form-submit")).toBeInTheDocument();
    });

    it("requires a non-empty email and validates client-side before POST", async () => {
        const onClose = vi.fn();
        const fetchSpy = vi.fn();
        const { container } = render(
            <InviteForm
                onClose={onClose}
                fetchFn={fetchSpy as unknown as typeof fetch}
            />,
        );
        // Type a bad email and submit.
        fireEvent.change(screen.getByTestId("invite-form-email"), {
            target: { value: "not-an-email" },
        });
        // Bypass the browser's HTMLFormElement check (jsdom respects required)
        // by submitting via the form's submit event. We need to dispatch on
        // the form because clicking the submit button hits required-field
        // validation first in some jsdom versions.
        const form = container.querySelector("form")!;
        fireEvent.submit(form);
        await waitFor(() => expect(screen.getByTestId("invite-form-client-error")).toBeInTheDocument());
        expect(screen.getByTestId("invite-form-client-error")).toHaveTextContent(/valid email/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("posts JSON and shows the email-sent success state", async () => {
        const onClose = vi.fn();
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({
            id: "inv-1",
            invite_url: "https://date.example/auth/invite/abc",
            expires_at: "2026-05-11T08:00:00+00:00",
            email: "newperson@example.com",
            role: "user",
            email_sent: true,
            email_warning: null,
        }, 201));
        render(
            <InviteForm
                onClose={onClose}
                fetchFn={fetchSpy as unknown as typeof fetch}
                autoDismissMs={0}
            />,
        );
        fireEvent.change(screen.getByTestId("invite-form-email"), {
            target: { value: "newperson@example.com" },
        });
        fireEvent.click(screen.getByTestId("invite-form-submit"));
        await waitFor(() => expect(screen.getByTestId("invite-form-success-sent")).toBeInTheDocument());
        expect(screen.getByTestId("invite-form-url")).toHaveTextContent("https://date.example/auth/invite/abc");
        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({ email: "newperson@example.com", role: "user" });
    });

    it("shows the email-failed banner when SMTP fails (no auto-dismiss)", async () => {
        const onClose = vi.fn();
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({
            id: "inv-1",
            invite_url: "https://date.example/auth/invite/abc",
            expires_at: "2026-05-11T08:00:00+00:00",
            email: "newperson@example.com",
            role: "user",
            email_sent: false,
            email_warning: "smtp connect refused",
        }, 201));
        render(
            <InviteForm
                onClose={onClose}
                fetchFn={fetchSpy as unknown as typeof fetch}
            />,
        );
        fireEvent.change(screen.getByTestId("invite-form-email"), {
            target: { value: "newperson@example.com" },
        });
        fireEvent.click(screen.getByTestId("invite-form-submit"));
        await waitFor(() => expect(screen.getByTestId("invite-form-success-failed")).toBeInTheDocument());
        expect(screen.getByTestId("invite-form-success-failed")).toHaveTextContent(/smtp connect refused/);
        // The "Close" button is the only way out; the modal must NOT auto-dismiss.
        expect(onClose).not.toHaveBeenCalled();
    });

    it("shows submit error inline when the server rejects the request", async () => {
        const onClose = vi.fn();
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({
            detail: "invalid email address",
        }, 422));
        render(
            <InviteForm
                onClose={onClose}
                fetchFn={fetchSpy as unknown as typeof fetch}
            />,
        );
        fireEvent.change(screen.getByTestId("invite-form-email"), {
            target: { value: "newperson@example.com" },
        });
        fireEvent.click(screen.getByTestId("invite-form-submit"));
        await waitFor(() => expect(screen.getByTestId("invite-form-submit-error")).toBeInTheDocument());
        expect(screen.getByTestId("invite-form-submit-error")).toHaveTextContent(/invalid email/);
        // Modal stays open.
        expect(onClose).not.toHaveBeenCalled();
    });

    it("copy button calls the injected copyImpl with the invite URL", async () => {
        const onClose = vi.fn();
        const copy = vi.fn().mockResolvedValue(undefined);
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({
            id: "inv-1",
            invite_url: "https://date.example/auth/invite/xyz",
            expires_at: "2026-05-11T08:00:00+00:00",
            email: "x@x.x",
            role: "user",
            email_sent: false,
            email_warning: "smtp down",
        }, 201));
        render(
            <InviteForm
                onClose={onClose}
                fetchFn={fetchSpy as unknown as typeof fetch}
                copyImpl={copy}
            />,
        );
        fireEvent.change(screen.getByTestId("invite-form-email"), {
            target: { value: "x@x.x" },
        });
        fireEvent.click(screen.getByTestId("invite-form-submit"));
        await waitFor(() => expect(screen.getByTestId("invite-form-success-failed")).toBeInTheDocument());
        fireEvent.click(screen.getByTestId("invite-form-copy"));
        await waitFor(() => expect(copy).toHaveBeenCalledWith("https://date.example/auth/invite/xyz"));
        await waitFor(() => expect(screen.getByTestId("invite-form-copy")).toHaveTextContent("Copied"));
    });

    it("Cancel calls onClose with createdSomething=false", () => {
        const onClose = vi.fn();
        render(<InviteForm onClose={onClose} />);
        fireEvent.click(screen.getByTestId("invite-form-cancel"));
        expect(onClose).toHaveBeenCalledWith(false);
    });

    it("Close (after success) calls onClose with createdSomething=true", async () => {
        const onClose = vi.fn();
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({
            id: "inv-1",
            invite_url: "https://date.example/auth/invite/abc",
            expires_at: "2026-05-11T08:00:00+00:00",
            email: "newperson@example.com",
            role: "user",
            email_sent: true,
            email_warning: null,
        }, 201));
        render(
            <InviteForm
                onClose={onClose}
                fetchFn={fetchSpy as unknown as typeof fetch}
                autoDismissMs={0}
            />,
        );
        fireEvent.change(screen.getByTestId("invite-form-email"), {
            target: { value: "newperson@example.com" },
        });
        fireEvent.click(screen.getByTestId("invite-form-submit"));
        await waitFor(() => expect(screen.getByTestId("invite-form-success-sent")).toBeInTheDocument());
        fireEvent.click(screen.getByTestId("invite-form-close"));
        expect(onClose).toHaveBeenCalledWith(true);
    });

    it("submits with role=admin when selected", async () => {
        const onClose = vi.fn();
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({
            id: "inv-2",
            invite_url: "https://date.example/auth/invite/admin",
            expires_at: "2026-05-11T08:00:00+00:00",
            email: "admin@example.com",
            role: "admin",
            email_sent: true,
            email_warning: null,
        }, 201));
        render(
            <InviteForm
                onClose={onClose}
                fetchFn={fetchSpy as unknown as typeof fetch}
                autoDismissMs={0}
            />,
        );
        fireEvent.change(screen.getByTestId("invite-form-email"), {
            target: { value: "admin@example.com" },
        });
        fireEvent.change(screen.getByTestId("invite-form-role"), {
            target: { value: "admin" },
        });
        fireEvent.click(screen.getByTestId("invite-form-submit"));
        await waitFor(() => expect(screen.getByTestId("invite-form-success-sent")).toBeInTheDocument());
        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        const body = JSON.parse(init.body as string);
        expect(body.role).toBe("admin");
    });
});
