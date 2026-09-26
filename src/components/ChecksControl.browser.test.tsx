import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { ChecksControl } from "./ChecksControl";
import "../styles.css";

it.each(["mythra", "light-mythra"])("keeps check results and editing usable in a narrow %s Review panel", async (theme) => {
  const onAddFeedback = vi.fn(() => true);
  const now = Date.now();
  const { container } = render(<div className="app-shell" data-theme={theme} data-color-scheme={theme.startsWith("light") ? "light" : "dark"} style={{ display: "block", width: 330, height: "auto", padding: 12 }}>
    <div className="studio-actions wrap review-actions">
      <button>Refresh</button><button>AI review</button>
      <ChecksControl command="npm run verify" running={false} result={{
        id: "run", projectId: "project", threadId: "thread", cwd: "/project/worktree", command: "npm run verify", head: "abc123",
        startedAt: now - 2400, finishedAt: now, status: "failed", exitCode: 1,
        output: "FAIL src/view.test.ts\nExpected the close animation to finish before unmounting.\n1 test failed", outputTruncated: true,
      }} onRun={vi.fn()} onStop={vi.fn()} onSave={vi.fn()} onAddFeedback={onAddFeedback} />
    </div>
  </div>);
  // The result card enters through a height reveal. Wait until its contents
  // are no longer clipped before exercising a real pointer click inside it;
  // WebKit can hit the clipping edge if the click lands during that transition.
  const resultClip = container.querySelector<HTMLElement>(".checks-result-reveal .checks-reveal-clip")!;
  await waitFor(() => expect(resultClip.scrollHeight - resultClip.clientHeight).toBeLessThanOrEqual(1));
  await userEvent.click(screen.getByRole("button", { name: "Output" }));
  expect(screen.getByRole("button", { name: "Output" })).toHaveAttribute("aria-expanded", "true");
  await waitFor(() => expect(screen.getByLabelText("Check output").getBoundingClientRect().height).toBeGreaterThan(40));
  await userEvent.click(screen.getByRole("button", { name: "Edit check command" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Check command" })).toHaveFocus());
  const panel = container.querySelector<HTMLElement>(".app-shell")!;
  expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
  for (const row of container.querySelectorAll<HTMLElement>(".checks-card-head, .checks-card-actions, .checks-popover .project-prompt-actions")) {
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
  }
  await page.screenshot({ element: panel, path: `../../test-results/checks-review-${theme}.png` });
  fireEvent.keyDown(document, { key: "Escape" });
  const editor = container.querySelector<HTMLElement>(".checks-popover-float")!;
  expect(editor.inert).toBe(true);
  await waitFor(() => expect(container.querySelector(".checks-popover-float")).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: "Ask agent to fix" }));
  expect(onAddFeedback).toHaveBeenCalledOnce();
});

it("keeps Find checks open while choosing a provider and model in native popover menus", async () => {
  localStorage.removeItem("kiwi.runDiscovery");
  const discovery = { pending: false, suggestion: null, error: "", discover: vi.fn(), cancel: vi.fn(), clearSuggestion: vi.fn() };
  const onSave = vi.fn();
  render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ width: 330, padding: 12 }}>
    <div className="studio-actions wrap review-actions">
      <ChecksControl
        running={false} result={null} discovery={discovery}
        discoveryCatalogs={{
          openai: [{ id: "gpt-5.6-luna", label: "Luna" }],
          claude: [{ id: "claude-sonnet-5", label: "Claude Sonnet" }, { id: "claude-opus-5", label: "Claude Opus" }],
        }}
        onRun={vi.fn()} onStop={vi.fn()} onSave={onSave} onAddFeedback={vi.fn()}
      />
    </div>
  </div>);

  await userEvent.click(screen.getByRole("button", { name: "Edit check command" }));
  await userEvent.click(await screen.findByRole("button", { name: "Discovery model settings" }));
  await userEvent.click(screen.getByRole("button", { name: "Discovery provider" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Claude" }));
  expect(screen.getByRole("dialog", { name: "Check command" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Discovery provider" })).toHaveTextContent("Claude");

  await userEvent.click(screen.getByRole("button", { name: "Discovery model" }));
  await userEvent.type(await screen.findByRole("textbox", { name: "Search Discovery model" }), "Opus");
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Claude Opus" }));
  expect(screen.getByRole("dialog", { name: "Check command" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Discovery model" })).toHaveTextContent("Claude Opus");

  await userEvent.click(within(screen.getByRole("dialog", { name: "Check command" })).getByRole("button", { name: "Find checks" }));
  expect(discovery.discover).toHaveBeenCalledWith(expect.objectContaining({ provider: "claude", model: "claude-opus-5" }), expect.any(Function));
  expect(onSave).not.toHaveBeenCalled();
});
