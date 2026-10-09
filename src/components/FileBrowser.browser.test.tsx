import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { FileBrowser } from "./FileBrowser";

const { rpcMock, invokeMock } = vi.hoisted(() => ({ rpcMock: vi.fn(), invokeMock: vi.fn() }));
vi.mock("../lib/codex", () => ({ rpc: rpcMock }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

type Preview = { text: string; truncated: boolean; binary: boolean };

function shell(onAttach = vi.fn(), root = "/project") {
  return <div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ width: 1000, height: 600 }}>
    <FileBrowser root={root} onAttach={onAttach} />
  </div>;
}

describe("bounded file previews and request-owned loading", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    invokeMock.mockReset();
    rpcMock.mockResolvedValue({ entries: [] });
    invokeMock.mockResolvedValue({ text: "small body", truncated: false, binary: false });
  });

  it("clears the spinner immediately when typing away an in-flight query", async () => {
    let resolveSearch: (value: { files: [] }) => void = () => {};
    rpcMock.mockImplementation((method: string) => method === "fuzzyFileSearch"
      ? new Promise((resolve) => { resolveSearch = resolve; })
      : Promise.resolve({ entries: [] }));
    const view = render(shell());
    await screen.findByText("This folder is empty");
    const search = screen.getByPlaceholderText("Search the whole project…");
    await userEvent.fill(search, "readme");
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith("fuzzyFileSearch", expect.anything()));
    expect(view.container.querySelector(".file-search .spin")).not.toBeNull();
    await userEvent.fill(search, "");
    await waitFor(() => expect(view.container.querySelector(".file-search .spin")).toBeNull());
    expect(screen.getByText("This folder is empty")).toBeVisible();
    await act(async () => resolveSearch({ files: [] }));
    expect(view.container.querySelector(".file-search .spin")).toBeNull();
  });

  it("preserves the listing on trusted clicks of the current root and folder breadcrumbs", async () => {
    rpcMock.mockImplementation((_method: string, params: { path: string }) => Promise.resolve({ entries: params.path === "/project"
      ? [{ fileName: "src", isDirectory: true, isFile: false }, { fileName: "README.md", isDirectory: false, isFile: true }]
      : [{ fileName: "main.ts", isDirectory: false, isFile: true }] }));
    render(shell());
    await screen.findByRole("button", { name: "README.md" });
    await userEvent.click(screen.getByTitle("/project"));
    expect(screen.getByRole("button", { name: "README.md" })).toBeVisible();
    expect(rpcMock).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "src" }));
    await screen.findByRole("button", { name: "main.ts" });
    await userEvent.click(screen.getByRole("button", { name: "src" }));
    expect(screen.getByRole("button", { name: "main.ts" })).toBeVisible();
    expect(rpcMock).toHaveBeenCalledTimes(2);

    await userEvent.fill(screen.getByPlaceholderText("Search the whole project…"), "missing");
    await screen.findByText("No matching files");
    await userEvent.click(screen.getByRole("button", { name: "src" }));
    expect(screen.getByRole("button", { name: "main.ts" })).toBeVisible();
    expect(screen.getByPlaceholderText("Search the whole project…")).toHaveValue("");
  });

  it("renders only the bounded large-file response and attaches the original file", async () => {
    rpcMock.mockImplementation((method: string) => method === "fs/readDirectory"
      ? Promise.resolve({ entries: [{ fileName: "large.txt", isDirectory: false, isFile: true }] })
      : Promise.resolve({ dataBase64: btoa("a".repeat(2_000_000)) }));
    invokeMock.mockResolvedValue({ text: "a".repeat(250_000), truncated: true, binary: false });
    const onAttach = vi.fn();
    const view = render(shell(onAttach));
    await userEvent.click(await screen.findByRole("button", { name: "large.txt" }));
    await waitFor(() => expect(view.container.querySelector(".file-preview pre")).toHaveTextContent("Preview truncated at 250,000 bytes."));
    expect(invokeMock).toHaveBeenCalledWith("preview_project_file", { root: "/project", path: "/project/large.txt" });
    expect(rpcMock.mock.calls.some(([method]) => method === "fs/readFile")).toBe(false);
    const preview = view.container.querySelector<HTMLElement>(".file-preview pre")!;
    expect(preview.textContent!.length).toBeLessThan(250_100);
    expect(preview.getBoundingClientRect().height).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Attach large.txt" }));
    expect(onAttach).toHaveBeenCalledWith("/project/large.txt");
  });

  it("reloads the current folder when it becomes the new project root", async () => {
    rpcMock.mockImplementation((_method: string, params: { path: string }) => Promise.resolve({ entries: params.path === "/project"
      ? [{ fileName: "src", isDirectory: true, isFile: false }]
      : [{ fileName: "main.ts", isDirectory: false, isFile: true }] }));
    const onAttach = vi.fn();
    const view = render(shell(onAttach));
    await userEvent.click(await screen.findByRole("button", { name: "src" }));
    await screen.findByRole("button", { name: "main.ts" });
    rpcMock.mockResolvedValue({ entries: [{ fileName: "new-root.ts", isDirectory: false, isFile: true }] });
    view.rerender(shell(onAttach, "/project/src"));
    expect(await screen.findByRole("button", { name: "new-root.ts" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Go to parent folder" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "new-root.ts" }));
    await screen.findByText("small body");
    expect(invokeMock).toHaveBeenCalledWith("preview_project_file", { root: "/project/src", path: "/project/src/new-root.ts" });
    await userEvent.click(screen.getByRole("button", { name: "Attach new-root.ts" }));
    expect(onAttach).toHaveBeenCalledWith("/project/src/new-root.ts");
  });

  it("keeps the newer selection when an older native preview completes late", async () => {
    let resolveSlow: (value: Preview) => void = () => {};
    rpcMock.mockResolvedValue({ entries: [
      { fileName: "slow.txt", isDirectory: false, isFile: true },
      { fileName: "fast.txt", isDirectory: false, isFile: true },
    ] });
    invokeMock.mockImplementation((_command: string, params: { path: string }) => params.path.endsWith("slow.txt")
      ? new Promise((resolve) => { resolveSlow = resolve; })
      : Promise.resolve({ text: "café 🦀", truncated: false, binary: false }));
    render(shell());
    await userEvent.click(await screen.findByRole("button", { name: "slow.txt" }));
    await userEvent.click(screen.getByRole("button", { name: "fast.txt" }));
    expect(await screen.findByText("café 🦀")).toBeVisible();
    await act(async () => resolveSlow({ text: "old body", truncated: false, binary: false }));
    expect(screen.queryByText("old body")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach fast.txt" })).toBeVisible();
    expect(screen.queryByText("Loading preview…")).not.toBeInTheDocument();
  });

  it("clears old entries and ignores a late preview during folder navigation", async () => {
    let resolveDirectory: (value: { entries: [] }) => void = () => {};
    let resolvePreview: (value: Preview) => void = () => {};
    rpcMock.mockImplementation((_method: string, params: { path?: string }) => params.path === "/project"
      ? Promise.resolve({ entries: [
        { fileName: "src", isDirectory: true, isFile: false },
        { fileName: "private.txt", isDirectory: false, isFile: true },
      ] })
      : new Promise((resolve) => { resolveDirectory = resolve; }));
    invokeMock.mockReturnValue(new Promise((resolve) => { resolvePreview = resolve; }));
    render(shell());
    await userEvent.click(await screen.findByRole("button", { name: "private.txt" }));
    await userEvent.click(screen.getByRole("button", { name: "src" }));
    expect(screen.queryByRole("button", { name: "private.txt" })).not.toBeInTheDocument();
    expect(screen.queryByTitle("/project/src/src")).not.toBeInTheDocument();
    await act(async () => resolvePreview({ text: "old file body", truncated: false, binary: false }));
    expect(screen.queryByText("old file body")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attach private.txt" })).not.toBeInTheDocument();
    await act(async () => resolveDirectory({ entries: [] }));
    expect(screen.getByText("This folder is empty")).toBeVisible();
  });
});
