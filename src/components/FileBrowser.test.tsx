import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileBrowser } from "./FileBrowser";

const { rpcMock, invokeMock } = vi.hoisted(() => ({ rpcMock: vi.fn(), invokeMock: vi.fn() }));
vi.mock("../lib/codex", () => ({ rpc: rpcMock }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

describe("FileBrowser", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ text: "hello", truncated: false, binary: false });
    rpcMock.mockImplementation((method: string, params: { path?: string }) => {
      if (method === "fs/readDirectory" && params.path === "/project") return Promise.resolve({ entries: [
        { fileName: "src", isDirectory: true, isFile: false },
        { fileName: "node_modules", isDirectory: true, isFile: false },
        { fileName: ".git", isDirectory: true, isFile: false },
        { fileName: "README.md", isDirectory: false, isFile: true },
      ] });
      if (method === "fs/readDirectory" && params.path === "/project/src") return Promise.resolve({ entries: [
        { fileName: "main.ts", isDirectory: false, isFile: true },
      ] });
      if (method === "fs/readFile") return Promise.resolve({ dataBase64: btoa("hello") });
      return Promise.resolve({ files: [] });
    });
  });

  it("hides generated folders by default and reveals them on request", async () => {
    render(<FileBrowser root="/project" onAttach={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "src" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "node_modules" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show generated and ignored folders" }));
    expect(screen.getByRole("button", { name: "node_modules" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ".git" })).toBeInTheDocument();
  });

  it("navigates into folders, updates breadcrumbs, and returns to the project root", async () => {
    render(<FileBrowser root="/project" onAttach={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "src" }));
    expect(await screen.findByRole("button", { name: "main.ts" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Current project folder" })).toHaveTextContent("projectsrc");
    expect(rpcMock).toHaveBeenCalledWith("fs/readDirectory", { path: "/project/src" });
    fireEvent.click(screen.getByTitle("/project"));
    await waitFor(() => expect(screen.getByRole("button", { name: "src" })).toBeInTheDocument());
  });

  it("keeps the loaded listing when clicking the current folder breadcrumb", async () => {
    render(<FileBrowser root="/project" onAttach={vi.fn()} />);
    await screen.findByRole("button", { name: "README.md" });
    fireEvent.click(screen.getByTitle("/project"));
    expect(screen.getByRole("button", { name: "README.md" })).toBeInTheDocument();
    expect(rpcMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "src" }));
    await screen.findByRole("button", { name: "main.ts" });
    fireEvent.click(screen.getByRole("button", { name: "src" }));
    expect(screen.getByRole("button", { name: "main.ts" })).toBeInTheDocument();
    expect(rpcMock).toHaveBeenCalledTimes(2);

    fireEvent.change(screen.getByPlaceholderText("Search the whole project…"), { target: { value: "missing" } });
    await screen.findByText("No matching files");
    fireEvent.click(screen.getByRole("button", { name: "src" }));
    expect(screen.getByRole("button", { name: "main.ts" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search the whole project…")).toHaveValue("");
  });

  it("navigates a Windows project with backslash paths", async () => {
    rpcMock.mockImplementation((method: string, params: { path?: string }) => {
      if (method === "fs/readDirectory" && params.path === "C:\\project") return Promise.resolve({ entries: [
        { fileName: "src", isDirectory: true, isFile: false },
        { fileName: "node_modules", isDirectory: true, isFile: false },
      ] });
      if (method === "fs/readDirectory" && params.path === "C:\\project\\src") return Promise.resolve({ entries: [
        { fileName: "main.ts", isDirectory: false, isFile: true },
      ] });
      if (method === "fs/readFile") return Promise.resolve({ dataBase64: btoa("hello") });
      return Promise.resolve({ files: [] });
    });
    const onAttach = vi.fn();
    // Braces matter: a JSX string attribute is literal, so `root="C:\\p"`
    // would pass two backslashes rather than the Windows separator.
    render(<FileBrowser root={"C:\\project\\"} onAttach={onAttach} />);

    // The root is trimmed and its own separator is used to descend.
    fireEvent.click(await screen.findByRole("button", { name: "src" }));
    expect(rpcMock).toHaveBeenCalledWith("fs/readDirectory", { path: "C:\\project\\src" });
    expect(screen.getByRole("navigation", { name: "Current project folder" })).toHaveTextContent("projectsrc");
    // Generated folders are still recognized across a backslash path.
    expect(screen.queryByRole("button", { name: "node_modules" })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "main.ts" }));
    expect(await screen.findByText("src\\main.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Attach main.ts" }));
    expect(onAttach).toHaveBeenCalledWith("C:\\project\\src\\main.ts");

    // Going up lands on the root, not above it.
    fireEvent.click(screen.getByRole("button", { name: "Go to parent folder" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Go to parent folder" })).toBeDisabled());
  });

  it("reloads when the new project root is the folder already being browsed", async () => {
    const view = render(<FileBrowser root="/project" onAttach={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "src" }));
    await screen.findByRole("button", { name: "main.ts" });
    rpcMock.mockResolvedValue({ entries: [{ fileName: "new-root.ts", isDirectory: false, isFile: true }] });
    view.rerender(<FileBrowser root="/project/src" onAttach={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "new-root.ts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to parent folder" })).toBeDisabled();
    expect(rpcMock.mock.calls.filter(([method, params]) => method === "fs/readDirectory" && params.path === "/project/src")).toHaveLength(2);
  });

  it("does not dispatch the old folder again when the project root changes", async () => {
    let resolveOld: (value: { entries: Array<{ fileName: string; isDirectory: boolean; isFile: boolean }> }) => void = () => {};
    rpcMock.mockImplementation((_method: string, params: { path?: string }) => params.path === "/project/src"
      ? new Promise((resolve) => { resolveOld = resolve; })
      : Promise.resolve({ entries: [{ fileName: "src", isDirectory: true, isFile: false }] }));
    const view = render(<FileBrowser root="/project" onAttach={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "src" }));
    view.rerender(<FileBrowser root="/other" onAttach={vi.fn()} />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith("fs/readDirectory", { path: "/other" }));
    expect(rpcMock.mock.calls.filter(([method, params]) => method === "fs/readDirectory" && params.path === "/project/src")).toHaveLength(1);
    await act(async () => resolveOld({ entries: [{ fileName: "old-private.txt", isDirectory: false, isFile: true }] }));
    expect(screen.queryByRole("button", { name: "old-private.txt" })).not.toBeInTheDocument();
  });

  it("never renders an earlier file's late preview under the newer selection", async () => {
    let resolveSlow: (value: { text: string; truncated: boolean; binary: boolean }) => void = () => {};
    rpcMock.mockImplementation((method: string) => {
      if (method === "fs/readDirectory") return Promise.resolve({ entries: [
        { fileName: "slow.txt", isDirectory: false, isFile: true },
        { fileName: "fast.txt", isDirectory: false, isFile: true },
      ] });
      return Promise.resolve({ files: [] });
    });
    invokeMock.mockImplementation((_command: string, params: { path?: string }) => {
      if (params.path === "/project/slow.txt") {
        return new Promise((resolve) => { resolveSlow = resolve as typeof resolveSlow; });
      }
      return Promise.resolve({ text: "fast body", truncated: false, binary: false });
    });
    render(<FileBrowser root="/project" onAttach={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "slow.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "fast.txt" }));
    expect(await screen.findByText("fast body")).toBeInTheDocument();

    await act(async () => {
      resolveSlow({ text: "slow body", truncated: false, binary: false });
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Attach fast.txt" })).toBeInTheDocument();
    expect(screen.getByText("fast body")).toBeInTheDocument();
    expect(screen.queryByText("slow body")).not.toBeInTheDocument();
    // The panel is not left claiming to still be loading either.
    expect(screen.queryByText("Loading preview…")).not.toBeInTheDocument();
  });

  it("clears the search spinner while a cleared query's response is still pending", async () => {
    let resolveSearch: (value: { files: [] }) => void = () => {};
    rpcMock.mockImplementation((method: string) => method === "fuzzyFileSearch"
      ? new Promise((resolve) => { resolveSearch = resolve as typeof resolveSearch; })
      : Promise.resolve({ entries: [] }));
    const view = render(<FileBrowser root="/project" onAttach={vi.fn()} />);
    await screen.findByText("This folder is empty");
    const search = screen.getByPlaceholderText("Search the whole project…");
    fireEvent.change(search, { target: { value: "readme" } });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith("fuzzyFileSearch", expect.anything()));
    expect(view.container.querySelector(".file-search .spin")).not.toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    expect(view.container.querySelector(".file-search .spin")).toBeNull();
    expect(screen.getByText("This folder is empty")).toBeInTheDocument();
    await act(async () => resolveSearch({ files: [] }));
    expect(view.container.querySelector(".file-search .spin")).toBeNull();
  });

  it("previews a large file through the bounded native command and attaches its original path", async () => {
    const body = "a".repeat(250_000);
    // The old path transferred/decoded the complete payload before clipping it.
    rpcMock.mockImplementation((method: string) => method === "fs/readDirectory"
      ? Promise.resolve({ entries: [{ fileName: "large.txt", isDirectory: false, isFile: true }] })
      : Promise.resolve({ dataBase64: btoa("a".repeat(2_000_000)) }));
    invokeMock.mockResolvedValue({ text: body, truncated: true, binary: false });
    const onAttach = vi.fn();
    const view = render(<FileBrowser root="/project" onAttach={onAttach} />);
    fireEvent.click(await screen.findByRole("button", { name: "large.txt" }));
    await waitFor(() => expect(view.container.querySelector(".file-preview pre")).toHaveTextContent("Preview truncated"));
    expect(invokeMock).toHaveBeenCalledWith("preview_project_file", { root: "/project", path: "/project/large.txt" });
    expect(rpcMock.mock.calls.some(([method]) => method === "fs/readFile")).toBe(false);
    expect(view.container.querySelector(".file-preview pre")!.textContent!.length).toBeLessThan(250_100);
    fireEvent.click(screen.getByRole("button", { name: "Attach large.txt" }));
    expect(onAttach).toHaveBeenCalledWith("/project/large.txt");
  });

  it("keeps the current search spinner when an unrelated directory read finishes", async () => {
    let resolveDirectory: (value: { entries: [] }) => void = () => {};
    let resolveSearch: (value: { files: [] }) => void = () => {};
    rpcMock.mockImplementation((method: string) => method === "fs/readDirectory"
      ? new Promise((resolve) => { resolveDirectory = resolve as typeof resolveDirectory; })
      : new Promise((resolve) => { resolveSearch = resolve as typeof resolveSearch; }));
    const view = render(<FileBrowser root="/project" onAttach={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Search the whole project…"), { target: { value: "readme" } });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith("fuzzyFileSearch", expect.anything()));
    await act(async () => resolveDirectory({ entries: [] }));
    expect(view.container.querySelector(".file-search .spin")).not.toBeNull();
    await act(async () => resolveSearch({ files: [] }));
    expect(view.container.querySelector(".file-search .spin")).toBeNull();
  });

  it("does not let a superseded search clear the newest request's spinner or results", async () => {
    const requests = new Map<string, (value: { files: Array<{ root: string; path: string; file_name: string; score: number }> }) => void>();
    rpcMock.mockImplementation((method: string, params: { query?: string }) => method === "fs/readDirectory"
      ? Promise.resolve({ entries: [] })
      : new Promise((resolve) => { requests.set(params.query!, resolve); }));
    const view = render(<FileBrowser root="/project" onAttach={vi.fn()} />);
    const search = screen.getByPlaceholderText("Search the whole project…");
    fireEvent.change(search, { target: { value: "old" } });
    await waitFor(() => expect(requests.has("old")).toBe(true));
    fireEvent.change(search, { target: { value: "new" } });
    await waitFor(() => expect(requests.has("new")).toBe(true));
    await act(async () => requests.get("old")!({ files: [{ root: "/project", path: "old.txt", file_name: "old.txt", score: 1 }] }));
    expect(view.container.querySelector(".file-search .spin")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "old.txt" })).not.toBeInTheDocument();
    await act(async () => requests.get("new")!({ files: [{ root: "/project", path: "new.txt", file_name: "new.txt", score: 1 }] }));
    expect(screen.getByRole("button", { name: "new.txt" })).toBeInTheDocument();
    expect(view.container.querySelector(".file-search .spin")).toBeNull();
  });

  it("invalidates a late file preview when the project root changes", async () => {
    let resolvePreview: (value: { text: string; truncated: boolean; binary: boolean }) => void = () => {};
    invokeMock.mockReturnValue(new Promise((resolve) => { resolvePreview = resolve; }));
    const view = render(<FileBrowser root="/project" onAttach={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    view.rerender(<FileBrowser root="/other" onAttach={vi.fn()} />);
    await act(async () => resolvePreview({ text: "old project's private content", truncated: false, binary: false }));
    expect(screen.queryByText("old project's private content")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attach README.md" })).not.toBeInTheDocument();
  });

  it("does not remap old folder entries while navigation is pending", async () => {
    let resolveDirectory: (value: { entries: [] }) => void = () => {};
    rpcMock.mockImplementation((method: string, params: { path?: string }) => {
      if (method === "fs/readDirectory" && params.path === "/project") return Promise.resolve({ entries: [
        { fileName: "src", isDirectory: true, isFile: false },
        { fileName: "private.txt", isDirectory: false, isFile: true },
      ] });
      return new Promise((resolve) => { resolveDirectory = resolve; });
    });
    render(<FileBrowser root="/project" onAttach={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "src" }));
    expect(screen.queryByRole("button", { name: "private.txt" })).not.toBeInTheDocument();
    expect(screen.queryByTitle("/project/src/src")).not.toBeInTheDocument();
    await act(async () => resolveDirectory({ entries: [] }));
    expect(screen.getByText("This folder is empty")).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ text: "", truncated: false, binary: true }, "This file is binary or cannot be previewed as UTF-8 text."],
    [{ text: "café 🦀", truncated: false, binary: false }, "café 🦀"],
  ])("renders native binary and UTF-8 preview results", async (result, expected) => {
    invokeMock.mockResolvedValue(result);
    render(<FileBrowser root="/project" onAttach={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });
});
