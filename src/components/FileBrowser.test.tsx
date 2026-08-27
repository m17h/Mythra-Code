import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileBrowser } from "./FileBrowser";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock("../lib/codex", () => ({ rpc: rpcMock }));

describe("FileBrowser", () => {
  beforeEach(() => {
    rpcMock.mockReset();
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

  it("never renders an earlier file's late preview under the newer selection", async () => {
    let resolveSlow: (value: { dataBase64: string }) => void = () => {};
    rpcMock.mockImplementation((method: string, params: { path?: string }) => {
      if (method === "fs/readDirectory") return Promise.resolve({ entries: [
        { fileName: "slow.txt", isDirectory: false, isFile: true },
        { fileName: "fast.txt", isDirectory: false, isFile: true },
      ] });
      if (method === "fs/readFile" && params.path === "/project/slow.txt") {
        return new Promise((resolve) => { resolveSlow = resolve as typeof resolveSlow; });
      }
      if (method === "fs/readFile") return Promise.resolve({ dataBase64: btoa("fast body") });
      return Promise.resolve({ files: [] });
    });
    render(<FileBrowser root="/project" onAttach={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "slow.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "fast.txt" }));
    expect(await screen.findByText("fast body")).toBeInTheDocument();

    await act(async () => {
      resolveSlow({ dataBase64: btoa("slow body") });
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Attach fast.txt" })).toBeInTheDocument();
    expect(screen.getByText("fast body")).toBeInTheDocument();
    expect(screen.queryByText("slow body")).not.toBeInTheDocument();
    // The panel is not left claiming to still be loading either.
    expect(screen.queryByText("Loading preview…")).not.toBeInTheDocument();
  });
});
