import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageToolsSnapshot } from "../lib/languageTools";
import { StrictMode } from "react";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), cleanup: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { LanguageToolsSettings } from "./LanguageToolsSettings";

function snapshot(overrides: Partial<LanguageToolsSnapshot> = {}): LanguageToolsSnapshot {
  return {
    autoInstall: true,
    generation: 1,
    tools: [
      { id: "typescript", name: "TypeScript", languages: ["TypeScript", "JavaScript"], state: "missing", health: "unverified", detail: "Uses the shared Node.js installation.", enabled: true },
      { id: "python", name: "Python", languages: ["Python"], state: "installed", health: "verified", detail: "Found an existing installation.", enabled: true },
    ],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

async function loaded() {
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "Enable TypeScript" })).toBeEnabled());
}

function notify(generation?: number) {
  const listener = mocks.listen.mock.calls[0][1] as (event: unknown) => void;
  listener({ payload: generation === undefined ? null : { generation } });
}

describe("language tool settings", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
    mocks.cleanup.mockReset();
    mocks.listen.mockResolvedValue(mocks.cleanup);
    mocks.invoke.mockResolvedValue(snapshot());
  });

  it("loads shared tools with automatic setup enabled and clear scope and cost", async () => {
    render(<LanguageToolsSettings />);
    await loaded();
    expect(screen.getByRole("switch", { name: "Automatic setup for new project threads" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Installed", { selector: ".language-tools-state" })).toBeInTheDocument();
    expect(screen.getByText(/including tools installed by a model/)).toBeInTheDocument();
    expect(screen.getByText(/does not call a model or spend API tokens/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install Python" })).toBeDisabled();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.listen).toHaveBeenCalledWith("language-tools-changed", expect.any(Function));
  });

  it("saves automatic setup immediately using its authoritative response without another read", async () => {
    let current = snapshot();
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "language_tools_set_auto_install") current = snapshot({ autoInstall: args.enabled });
      return current;
    });
    render(<LanguageToolsSettings />);
    await loaded();
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false"));
    expect(mocks.invoke).toHaveBeenCalledWith("language_tools_set_auto_install", { enabled: false });
    expect(screen.getByText("Automatic setup disabled.")).toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("lets each tool be disabled independently", async () => {
    let current = snapshot();
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "language_tools_set_enabled") current = { ...current, tools: current.tools.map((tool) => tool.id === args.id ? { ...tool, enabled: args.enabled } : tool) };
      return current;
    });
    render(<LanguageToolsSettings />);
    await loaded();
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable TypeScript" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Enable TypeScript" })).not.toBeChecked());
    expect(screen.getByRole("checkbox", { name: "Enable Python" })).toBeChecked();
    expect(mocks.invoke).toHaveBeenCalledWith("language_tools_set_enabled", { id: "typescript", enabled: false });
    expect(screen.getByText("TypeScript disabled.")).toBeInTheDocument();
  });

  it("installs only the selected tool and guards duplicate clicks until completion", async () => {
    const installing = deferred<LanguageToolsSnapshot>();
    let current = snapshot();
    mocks.invoke.mockImplementation((command) => command === "language_tools_install" ? installing.promise : Promise.resolve(current));
    render(<LanguageToolsSettings />);
    await loaded();
    const button = screen.getByRole("button", { name: "Install TypeScript" });
    act(() => { button.click(); button.click(); });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "language_tools_install")).toEqual([["language_tools_install", { id: "typescript" }]]);
    expect(button).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Enable TypeScript" })).toBeDisabled();
    current = { ...current, tools: current.tools.map((tool) => ({ ...tool, state: "installed" })) };
    await act(async () => installing.resolve(current));
    await waitFor(() => expect(screen.getByText("TypeScript is installed.")).toBeInTheDocument());
    expect(button).toHaveTextContent("Installed");
  });

  it("persists multiple selected installs immediately and keeps them after reopening", async () => {
    let current = snapshot({ tools: snapshot().tools.map((tool) => ({ ...tool, state: "missing", health: "unverified" })) });
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "language_tools_install") current = {
        ...current, generation: current.generation + 1,
        tools: current.tools.map((tool) => tool.id === args.id ? { ...tool, state: "installed", health: "verified" } : tool),
      };
      return current;
    });
    const first = render(<LanguageToolsSettings />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Install TypeScript" }));
    await waitFor(() => expect(screen.getByText("TypeScript is installed.")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Install Python" }));
    await waitFor(() => expect(screen.getByText("Python is installed.")).toBeInTheDocument());
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["language_tools_snapshot", "language_tools_install", "language_tools_install"]);
    first.unmount();
    render(<LanguageToolsSettings />);
    await loaded();
    expect(screen.getByRole("button", { name: "Install TypeScript" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Install Python" })).toBeDisabled();
  });

  it("coalesces event bursts into one in-flight read and one dirty follow-up", async () => {
    render(<LanguageToolsSettings />);
    await loaded();
    const oldRead = deferred<LanguageToolsSnapshot>();
    const installed = snapshot({ generation: 3, tools: snapshot().tools.map((tool) => ({ ...tool, state: "installed" })) });
    mocks.invoke.mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(installed);
    act(() => { for (let index = 0; index < 20; index += 1) notify(2); });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
    act(() => { for (let index = 0; index < 20; index += 1) notify(3); });
    await act(async () => oldRead.resolve(snapshot({ generation: 2 })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Install TypeScript" })).toHaveTextContent("Installed"));
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
  });

  it("does not announce a superseded setting snapshot as the current outcome", async () => {
    render(<LanguageToolsSettings />);
    await loaded();
    const mutation = deferred<LanguageToolsSnapshot>();
    mocks.invoke.mockReturnValueOnce(mutation.promise).mockResolvedValueOnce(snapshot({ generation: 3 }));
    fireEvent.click(screen.getByRole("switch"));
    act(() => notify(3));
    await act(async () => mutation.resolve(snapshot({ generation: 2, autoInstall: false })));
    await waitFor(() => expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true"));
    expect(screen.queryByText("Automatic setup disabled.")).not.toBeInTheDocument();
  });

  it("does not refetch events already covered by a mutation response", async () => {
    const mutation = deferred<LanguageToolsSnapshot>();
    mocks.invoke.mockImplementation((command) => command === "language_tools_set_auto_install" ? mutation.promise : Promise.resolve(snapshot()));
    render(<LanguageToolsSettings />);
    await loaded();
    fireEvent.click(screen.getByRole("switch"));
    act(() => { notify(2); notify(2); });
    await act(async () => mutation.resolve(snapshot({ generation: 2, autoInstall: false })));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("cancels a queued event read when the next mutation response already covers it", async () => {
    render(<LanguageToolsSettings />);
    await loaded();
    mocks.invoke.mockResolvedValueOnce(snapshot({ generation: 3, autoInstall: false }));
    act(() => notify(2));
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it.each(["resolve", "reject"] as const)("keeps a newer saved setting when an older inventory read %s completes", async (completion) => {
    render(<LanguageToolsSettings />);
    await loaded();
    const read = deferred<LanguageToolsSnapshot>();
    mocks.invoke.mockReturnValueOnce(read.promise).mockResolvedValueOnce(snapshot({ generation: 3, autoInstall: false }));
    act(() => notify(2));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.getByText("Automatic setup disabled.")).toBeInTheDocument());
    await act(async () => completion === "resolve" ? read.resolve(snapshot({ generation: 2 })) : read.reject(new Error("obsolete failure")));
    expect(screen.queryByText(/obsolete failure/)).not.toBeInTheDocument();
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it.each(["before", "after"] as const)("keeps a rejected setting's actionable failure when unrelated inventory arrives %s rejection", async (order) => {
    render(<LanguageToolsSettings />);
    await loaded();
    const read = deferred<LanguageToolsSnapshot>();
    const mutation = deferred<LanguageToolsSnapshot>();
    const unrelated = snapshot({ generation: 2, tools: snapshot().tools.map((tool) => tool.id === "python" ? { ...tool, detail: "Installed by another thread." } : tool) });
    mocks.invoke.mockReturnValueOnce(read.promise).mockReturnValueOnce(mutation.promise).mockResolvedValue(snapshot({ ...unrelated, generation: 3 }));
    act(() => notify(2));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("switch"));
    if (order === "before") await act(async () => read.resolve(unrelated));
    await act(async () => mutation.reject(new Error("Could not persist language tool settings. Check storage permissions, then retry.")));
    if (order === "after") await act(async () => read.resolve(unrelated));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(4));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Check storage permissions, then retry");
    expect(screen.queryByText("Automatic setup disabled.")).not.toBeInTheDocument();
    mocks.invoke.mockResolvedValueOnce(snapshot({ generation: 4, autoInstall: false }));
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.getByText("Automatic setup disabled.")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores an old mount's response after StrictMode remount and does not leak listeners", async () => {
    const first = deferred<LanguageToolsSnapshot>();
    mocks.invoke.mockReturnValueOnce(first.promise).mockResolvedValueOnce(snapshot({ generation: 3, autoInstall: false }));
    const view = render(<StrictMode><LanguageToolsSettings /></StrictMode>);
    await loaded();
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    await act(async () => first.resolve(snapshot({ generation: 4 })));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    view.unmount();
    expect(mocks.cleanup).toHaveBeenCalledTimes(2);
  });

  it("shows stored tools promptly and verifies health only with explicit Refresh", async () => {
    const tools = snapshot().tools.map((tool) => ({ ...tool, state: "available" as const, health: tool.id === "python" ? "stale" as const : "unverified" as const }));
    const health = deferred<LanguageToolsSnapshot>();
    mocks.invoke.mockImplementation((command) => command === "language_tools_refresh" ? health.promise : Promise.resolve(snapshot({ tools })));
    render(<LanguageToolsSettings />);
    await loaded();
    expect(screen.getByText("Not yet verified")).toBeInTheDocument();
    expect(screen.getByText("Verification expired")).toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh language tools" }));
    expect(screen.getAllByText("Checking…")).toHaveLength(2);
    expect(mocks.invoke).toHaveBeenLastCalledWith("language_tools_refresh");
    await act(async () => health.resolve(snapshot({ generation: 2 })));
    expect(screen.queryByText("Checking…")).not.toBeInTheDocument();
  });

  it("makes a failed available server actionable after explicit health verification", async () => {
    const available = snapshot({ tools: [{ ...snapshot().tools[0], state: "available", health: "unverified" }] });
    const failed = snapshot({ generation: 2, tools: [{ ...available.tools[0], state: "error", health: "error", detail: "The server could not initialize. Retry installation." }] });
    mocks.invoke.mockResolvedValueOnce(available).mockResolvedValueOnce(failed).mockResolvedValueOnce(snapshot({ generation: 3, tools: [{ ...available.tools[0], state: "installed", health: "verified" }] }));
    render(<LanguageToolsSettings />);
    await loaded();
    expect(screen.getByRole("button", { name: "Install TypeScript" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh language tools" }));
    await waitFor(() => expect(screen.getByText("Verification failed")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Retry installing TypeScript" }));
    await waitFor(() => expect(screen.getByText("TypeScript is installed.")).toBeInTheDocument());
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["language_tools_snapshot", "language_tools_refresh", "language_tools_install"]);
  });

  it("announces an installation failure returned in a successful native snapshot", async () => {
    let current = snapshot();
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "language_tools_install") current = {
        ...current,
        tools: current.tools.map((tool) => tool.id === "typescript" ? { ...tool, state: "error", detail: "Download failed. Check your connection, then retry." } : tool),
      };
      return current;
    });
    render(<LanguageToolsSettings />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Install TypeScript" }));
    await waitFor(() => expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("Download failed"))).toBe(true));
    expect(screen.getByRole("button", { name: "Retry installing TypeScript" })).toBeEnabled();
  });

  it.each(["returned", "rejected"] as const)("clears a %s installation failure only after that same tool is installed and verified", async (failure) => {
    let current = snapshot();
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "language_tools_install") {
        current = snapshot({ generation: 2, tools: current.tools.map((tool) => tool.id === "typescript" ? { ...tool, state: "error", health: "unverified", detail: "Download failed." } : tool) });
        if (failure === "rejected") throw new Error("Download failed.");
      }
      return current;
    });
    render(<LanguageToolsSettings />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Install TypeScript" }));
    const expectFailure = () => expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("Download failed"))).toBe(true);
    await waitFor(expectFailure);
    if (failure === "rejected") await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(3));
    current = { ...current, generation: 3, tools: current.tools.map((tool) => tool.id === "python" ? { ...tool, state: "installed", health: "verified", detail: "Installed by another thread." } : tool) };
    act(() => notify(3));
    await waitFor(() => expect(screen.getByText("Installed by another thread.")).toBeInTheDocument());
    expectFailure();
    current = { ...current, generation: 4, tools: current.tools.map((tool) => tool.id === "typescript" ? { ...tool, state: "available", health: "unverified", detail: "Found an installation awaiting verification." } : tool) };
    act(() => notify(4));
    await waitFor(() => expect(screen.getByText("Found an installation awaiting verification.")).toBeInTheDocument());
    expectFailure();
    current = { ...current, generation: 5, tools: current.tools.map((tool) => tool.id === "typescript" ? { ...tool, state: "installed", health: "unverified", detail: "Installation registered; verification pending." } : tool) };
    act(() => notify(5));
    await waitFor(() => expect(screen.getByText("Installation registered; verification pending.")).toBeInTheDocument());
    expectFailure();
    current = { ...current, generation: 6, tools: current.tools.map((tool) => tool.id === "typescript" ? { ...tool, state: "installed", health: "verified", detail: "Verified by another thread." } : tool) };
    act(() => notify(6));
    await waitFor(() => expect(screen.getByText("Verified by another thread.")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install TypeScript" })).toBeDisabled();
  });

  it("does not announce an obsolete install rejection when that same tool is already verified", async () => {
    render(<LanguageToolsSettings />);
    await loaded();
    const read = deferred<LanguageToolsSnapshot>();
    const mutation = deferred<LanguageToolsSnapshot>();
    const installed = snapshot({ generation: 2, tools: snapshot().tools.map((tool) => tool.id === "typescript" ? { ...tool, state: "installed", health: "verified" } : tool) });
    mocks.invoke.mockReturnValueOnce(read.promise).mockReturnValueOnce(mutation.promise).mockResolvedValue(installed);
    act(() => notify(2));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Install TypeScript" }));
    await act(async () => read.resolve(installed));
    await act(async () => mutation.reject(new Error("Superseded setup failed.")));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(4));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install TypeScript" })).toHaveTextContent("Installed");
  });

  it("keeps a returned installation failure actionable without a redundant scan", async () => {
    render(<LanguageToolsSettings />);
    await loaded();
    mocks.invoke
      .mockResolvedValueOnce(snapshot({ tools: snapshot().tools.map((tool) => tool.id === "typescript" ? { ...tool, state: "error", detail: "Download failed. Check your connection, then retry." } : tool) }))
      .mockRejectedValueOnce(new Error("Language tool registry is unavailable."));
    fireEvent.click(screen.getByRole("button", { name: "Install TypeScript" }));
    await waitFor(() => expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("Download failed"))).toBe(true));
    expect(screen.queryByText(/The change was saved/)).not.toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("refreshes state after a failed install and keeps the actionable failure visible", async () => {
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "language_tools_install") throw new Error("Node.js is required. Install Node.js, then retry.");
      return snapshot();
    });
    render(<LanguageToolsSettings />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Install TypeScript" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Node.js is required"));
    expect(screen.getByRole("button", { name: "Install TypeScript" })).toBeEnabled();
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "language_tools_snapshot")).toHaveLength(2));
    expect(screen.getByRole("alert")).toHaveTextContent("Node.js is required");
  });

  it("shows backend prerequisites and failures without claiming a completed install", async () => {
    const tools = snapshot().tools;
    mocks.invoke.mockResolvedValue(snapshot({ tools: [
      { ...tools[0], state: "unavailable", detail: "Install Node.js before setting up this tool." },
      { ...tools[1], state: "error", detail: "Download failed. Check your connection." },
    ] }));
    render(<LanguageToolsSettings />);
    await loaded();
    expect(screen.getByRole("button", { name: "Install TypeScript" })).toBeDisabled();
    expect(screen.getByText("Install Node.js before setting up this tool.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry installing Python" })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Setup failed");
  });

  it("disables a tool's controls while an external installer owns it", async () => {
    const tools = snapshot().tools;
    mocks.invoke.mockResolvedValue(snapshot({ tools: [{ ...tools[0], state: "installing", detail: "Installing with a model request." }, tools[1]] }));
    render(<LanguageToolsSettings />);
    await waitFor(() => expect(screen.getByText("Installing with a model request.")).toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: "Enable TypeScript" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Install TypeScript" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Enable Python" })).toBeEnabled();
  });

  it("allows recovery from an initial snapshot error using Refresh", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("Language tool registry is unavailable.")).mockResolvedValue(snapshot());
    render(<LanguageToolsSettings />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Language tool registry is unavailable"));
    expect(screen.getByRole("switch")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh language tools" }));
    await loaded();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("cleans up a listener that finishes registration after unmount", async () => {
    const registration = deferred<() => void>();
    mocks.listen.mockReturnValue(registration.promise);
    const view = render(<LanguageToolsSettings />);
    view.unmount();
    await act(async () => registration.resolve(mocks.cleanup));
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });

  it("shows metadata before a slow subscription and reconciles its missed-event interval", async () => {
    const registration = deferred<() => void>();
    mocks.listen.mockReturnValue(registration.promise);
    render(<LanguageToolsSettings />);
    await loaded();
    expect(mocks.invoke).toHaveBeenCalledOnce();
    mocks.invoke.mockResolvedValueOnce(snapshot({ generation: 2, autoInstall: false }));
    await act(async () => registration.resolve(mocks.cleanup));
    await waitFor(() => expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false"));
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("cleans up live listeners and ignores notifications after unmount", async () => {
    const view = render(<LanguageToolsSettings />);
    await loaded();
    view.unmount();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    act(() => notify());
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("offers manual refresh when native event registration fails", async () => {
    mocks.listen.mockRejectedValue(new Error("event bridge unavailable"));
    render(<LanguageToolsSettings />);
    await loaded();
    expect(screen.getByText(/Live updates are unavailable/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh language tools" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
  });
});
