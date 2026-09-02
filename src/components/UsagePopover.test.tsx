import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerHeaderUsage, type AccountUsageView } from "../lib/providerUsage";
import { UsagePopover } from "./UsagePopover";

const usage: AccountUsageView = {
  label: "Claude subscription", summary: "Max plan · 5h 80% left · Weekly 40% left · Weekly Fable 10% left", planLabel: "Max plan",
  windows: [
    { label: "5h", percent: 80, percentLabel: "80% left", resetLabel: "4 PM" },
    { label: "Weekly", percent: 40, percentLabel: "40% left", resetLabel: "Fri · 3 PM" },
    { label: "Weekly Fable", percent: 10, percentLabel: "10% left", resetLabel: "" },
  ],
};

function Harness({ data = usage, initial = "5h", onDetails = vi.fn(), onConnect = vi.fn() }: { data?: AccountUsageView; initial?: string; onDetails?: () => void; onConnect?: () => void }) {
  const [selected, select] = useState(initial);
  return <><UsagePopover provider="claude" usage={data} header={providerHeaderUsage("claude", data, { selectedWindow: selected })!} selectedLabel={selected} onSelect={select} onDetails={onDetails} onConnect={onConnect} /><button>Outside</button></>;
}

afterEach(() => vi.useRealTimers());

describe("usage popover", () => {
  it("does not dismiss on WebKit's null-target blur when clicking a radio", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Open usage details/ }));
    fireEvent.blur(screen.getByRole("radio", { name: "Show 5h in top bar" }), { relatedTarget: null });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Show Weekly Fable in top bar" }));
    expect(screen.getByRole("button", { name: /Open usage details/ })).toHaveTextContent("Weekly Fable 10% left");
  });

  it("shows one chosen limit in the chip and all limits in an app-owned dialog", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: /Claude subscription: 5h 80% left/ });
    expect(trigger).not.toHaveAttribute("title");
    expect(trigger).not.toHaveTextContent("Weekly");
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Claude usage details" });
    expect(within(dialog).getAllByRole("radio")).toHaveLength(3);
    expect(within(dialog).getByText("Resets Fri · 3 PM")).toBeInTheDocument();
    expect(within(dialog).getByText("Reset time unavailable")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Show Weekly Fable in top bar" }));
    expect(trigger).toHaveTextContent("Weekly Fable 10% left");
    expect(trigger).not.toHaveTextContent("80% left");
    expect(screen.getByRole("radio", { name: "Show Weekly Fable in top bar" })).toBeChecked();
  });

  it("opens on hover without taking focus and pins on click until dismissed", () => {
    vi.useFakeTimers();
    render(<Harness />);
    const outside = screen.getByRole("button", { name: "Outside" });
    outside.focus();
    const trigger = screen.getByRole("button", { name: /Open usage details/ });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(outside).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.pointerDown(outside);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes hover-only details after the pointer leaves and cancels a pending open", () => {
    vi.useFakeTimers();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: /Open usage details/ });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(200));
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not swallow the app's stop-turn shortcut for an incidental hover", () => {
    vi.useFakeTimers();
    render(<Harness />);
    screen.getByRole("button", { name: "Outside" }).focus();
    fireEvent.pointerEnter(screen.getByRole("button", { name: /Open usage details/ }), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(200));
    const appEscape = vi.fn();
    document.addEventListener("keydown", appEscape);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    document.removeEventListener("keydown", appEscape);
    expect(appEscape).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("supports keyboard radio navigation and consumes Escape without cancelling app work", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: /Open usage details/ });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: "Show 5h in top bar" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: "Show Weekly in top bar" })).toBeChecked();
    const appEscape = vi.fn();
    document.addEventListener("keydown", appEscape);
    await user.keyboard("{Escape}");
    document.removeEventListener("keydown", appEscape);
    expect(appEscape).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("falls back when a saved window disappears and restores it when the provider reports it again", async () => {
    const view = render(<Harness initial="Weekly Fable" />);
    expect(screen.getByRole("button", { name: /Open usage details/ })).toHaveTextContent("Weekly Fable 10% left");
    view.rerender(<Harness initial="Weekly Fable" data={{ ...usage, windows: usage.windows!.slice(0, 2) }} />);
    expect(screen.getByRole("button", { name: /Open usage details/ })).toHaveTextContent("5h 80% left");
    view.rerender(<Harness initial="Weekly Fable" />);
    expect(screen.getByRole("button", { name: /Open usage details/ })).toHaveTextContent("Weekly Fable 10% left");
  });

  it("shows unavailable data honestly and provides a connection action", async () => {
    const onConnect = vi.fn();
    const user = userEvent.setup();
    render(<Harness data={{ label: "Claude subscription", summary: "Sign in to Claude Code to view this account" }} onConnect={onConnect} />);
    await user.click(screen.getByRole("button", { name: /Open usage details/ }));
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Models & accounts" }));
    expect(onConnect).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("dismisses on keyboard focus leaving and opens the existing details surface", async () => {
    const user = userEvent.setup();
    const onDetails = vi.fn();
    render(<Harness onDetails={onDetails} />);
    await user.click(screen.getByRole("button", { name: /Open usage details/ }));
    await user.click(screen.getByRole("button", { name: "More usage details" }));
    expect(onDetails).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: /Open usage details/ }));
    act(() => screen.getByRole("button", { name: "Outside" }).focus());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
