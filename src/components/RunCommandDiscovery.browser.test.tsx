import { useState } from "react";
import type { ProjectRunCommand } from "../types";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { invoke } from "@tauri-apps/api/core";
import { ProjectRunControl } from "./ProjectRunControl";
import "../styles.css";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => { localStorage.clear(); vi.mocked(invoke).mockReset(); });
it("keeps discovery settings and the proposed command usable in the run popover", async () => {
  vi.mocked(invoke).mockResolvedValue({ command: "npm run desktop", label: "Desktop app", explanation: "The desktop script starts the development app." });
  const onSave = vi.fn(), onRun = vi.fn();
  function RunHarness() {
    const [run, setRun] = useState<ProjectRunCommand>();
    return <div className="app-shell" style={{ display: "block", padding: 20, height: 850 }}><ProjectRunControl projectName="Mythra Code" projectPath="/project" discoveryCatalogs={{ openai: [{ id: "gpt-5.6-luna", label: "Luna", efforts: ["low", "high"] }] }} run={run} running={false} onRun={onRun} onStop={vi.fn()} onSave={(next) => { onSave(next); setRun(next ? { ...next, updatedAt: 1 } : undefined); }} /></div>;
  }
  render(<RunHarness />);
  fireEvent.click(screen.getByRole("button", { name: "Edit run command" }));
  fireEvent.click(await screen.findByRole("button", { name: "Discovery model settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Discovery model" }));
  const option = await screen.findByRole("menuitemradio", { name: "Luna" });
  expect(option.getBoundingClientRect().height).toBeGreaterThan(0);
  fireEvent.click(option);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Find run command" })));
  expect(await screen.findByText("Saved to Run")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Run: ready" })).toHaveTextContent("Desktop app");
  const dialog = screen.getByRole("dialog");
  await waitFor(() => expect(dialog.getBoundingClientRect().top).toBeGreaterThanOrEqual(0));
  expect(dialog.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
  if (import.meta.env.VITE_RUN_DISCOVERY_SCREENSHOT) await page.screenshot({ path: import.meta.env.VITE_RUN_DISCOVERY_SCREENSHOT });
  const saveRect = screen.getByRole("button", { name: "Save run command" }).getBoundingClientRect();
  expect(saveRect.bottom).toBeLessThanOrEqual(dialog.getBoundingClientRect().bottom);
  expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
  expect(screen.getByRole("textbox", { name: "Run command for Mythra Code" })).toHaveValue("npm run desktop");
  expect(onRun).not.toHaveBeenCalled();
  expect(onSave).toHaveBeenCalledOnce();
  expect(onSave).toHaveBeenCalledWith({ command: "npm run desktop", label: "Desktop app" });
});

it("keeps all five provider choices clickable in a short window", async () => {
  await page.viewport(760, 650);
  render(<div className="app-shell" style={{ display: "block", padding: 20, height: 650 }}><ProjectRunControl projectName="Example" projectPath="/project" running={false} onRun={vi.fn()} onStop={vi.fn()} onSave={vi.fn()} /></div>);
  await page.getByRole("button", { name: "Edit run command" }).click();
  await page.getByRole("button", { name: "Discovery model settings" }).click();
  for (const label of ["Cursor", "OpenRouter", "LM Studio", "Claude", "OpenAI"]) {
    await page.getByRole("button", { name: "Discovery provider", exact: true }).click();
    const choice = await screen.findByRole("menuitemradio", { name: label });
    const rect = choice.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(choice.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))).toBe(true);
    await page.getByRole("menuitemradio", { name: label, exact: true }).click();
  }
  if (import.meta.env.VITE_RUN_DISCOVERY_SETTINGS_SCREENSHOT) await page.screenshot({ path: import.meta.env.VITE_RUN_DISCOVERY_SETTINGS_SCREENSHOT });
  const dialog = screen.getByRole("dialog");
  expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.viewport(1280, 900);
});

it("keeps optional setup visible, editable and saveable in a short Run window", async () => {
  await page.viewport(760, 650);
  const onSave = vi.fn();
  render(<div className="app-shell" data-theme="mythra" style={{ display: "block", padding: 20, height: 650 }}>
    <ProjectRunControl projectName="Example" projectPath="/project" run={{ command: "npm run dev", setupCommand: "npm install", updatedAt: 1 }} running={false} onRun={vi.fn()} onStop={vi.fn()} onSave={onSave} />
  </div>);
  await page.getByRole("button", { name: "Edit run command" }).click();
  const input = await screen.findByRole("textbox", { name: "Setup command for Example" });
  expect(input).toHaveValue("npm install");
  await page.getByRole("textbox", { name: "Setup command for Example" }).fill("npm ci");
  const dialog = screen.getByRole("dialog");
  expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
  await page.getByRole("button", { name: "Save run command" }).click();
  expect(onSave).toHaveBeenCalledWith({ command: "npm run dev", label: "", setupCommand: "npm ci" });
  await page.viewport(1400, 900);
});
