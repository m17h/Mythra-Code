import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { SkillPromptEditor } from "./SkillPromptEditor";
import { useModalFocus } from "../hooks/useModalFocus";
import "../styles.css";
import type { SkillDependencyReport } from "../types";
import { skillDependencyFixture } from "../test/skillDependencyFixtures";

const skills = [
  { name: "review", path: "/selected/review.md", description: "Review changes" },
  { name: "release", path: "/selected/release.md", description: "Release checks" },
  { name: "disabled", enabled: false },
];

function Fixture({ initial = "", width = 520, zoom = 1, font = "system", onChange = vi.fn(), onAnalyze, colorScheme = "dark" }: {
  initial?: string; width?: number; zoom?: number; font?: "system" | "mono"; onChange?: (value: string) => void;
  onAnalyze?: (text: string) => Promise<SkillDependencyReport>; colorScheme?: "light" | "dark";
}) {
  const [text, setText] = useState(initial);
  return <div className="app-shell" data-theme="mythra" data-color-scheme={colorScheme} style={{ width, height: "auto", display: "block", marginTop: 230, zoom }}>
    <div className="project-prompt-editor">
      <SkillPromptEditor value={text} skills={skills} aria-label="System instructions" rows={4} onAnalyze={onAnalyze}
        style={{ height: 128, fontFamily: font === "mono" ? "var(--font-mono)" : "var(--font-sans)" }}
        onChange={(event) => { setText(event.target.value); onChange(event.target.value); }} />
    </div>
  </div>;
}

function ClippedDialogFixture({ onOutside }: { onOutside: () => void }) {
  const [value, setValue] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, true);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!dialogRef.current?.contains(event.target as Node)) onOutside();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onOutside]);
  return <div className="app-shell" data-theme="mythra" data-color-scheme="light"
    style={{ width: 290, height: 180, display: "block", marginTop: 220, zoom: 1.25, overflow: "hidden", transform: "translateZ(0)" }}>
    <div ref={dialogRef} role="dialog" aria-label="Clipped settings" style={{ height: 150, overflow: "hidden", transform: "translateY(0)" }}>
      <div className="project-prompt-editor">
        <SkillPromptEditor aria-label="Clipped instructions" value={value} skills={skills} rows={4}
          onChange={(event) => setValue(event.target.value)} />
      </div>
      <input aria-label="Last setting" />
      <span data-testid="theme-reference" style={{ background: "var(--panel-2)", color: "var(--info)" }}>Theme</span>
    </div>
  </div>;
}

afterEach(async () => {
  await commands.setStreamTestReducedMotion(false);
  await page.viewport(1400, 900);
});

describe("system prompt skill editor in a real browser", () => {
  it.each(["light", "dark"] as const)("shows a nested failure and a red parent token while preserving keyboard editing in %s", async (colorScheme) => {
    await page.viewport(430, 800);
    const analyze = vi.fn(async () => skillDependencyFixture(true));
    const view = render(<Fixture initial="Use @review" width={330} onAnalyze={analyze} colorScheme={colorScheme} />);
    expect(await screen.findByText("Turn blocked by skill dependencies")).toBeVisible();
    const token = view.container.querySelector<HTMLElement>(".skill-prompt-token.is-blocked")!;
    const notice = view.container.querySelector<HTMLElement>(".skill-dependency-notice")!;
    expect(token).toHaveTextContent("@review");
    expect(getComputedStyle(token).color).toBe(getComputedStyle(notice).color);
    expect(getComputedStyle(token).textDecorationStyle).toBe("wavy");
    expect(screen.getByText("@review → @tests → references/checklist.md")).toBeVisible();
    expect(notice.scrollWidth).toBeLessThanOrEqual(notice.clientWidth + 1);
    expect(notice.getBoundingClientRect().right).toBeLessThanOrEqual(innerWidth);
    const input = screen.getByRole("textbox", { name: "System instructions" }) as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    await userEvent.keyboard("{End} then inspect");
    expect(input).toHaveValue("Use @review then inspect");
    expect(document.activeElement).toBe(input);
  });
  it("escapes clipped dialogs without popover support while preserving live theme, zoom and modal focus", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "showPopover");
    Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, writable: true, value: undefined });
    let view: ReturnType<typeof render> | undefined;
    try {
      await page.viewport(430, 700);
      const onOutside = vi.fn();
      view = render(<ClippedDialogFixture onOutside={onOutside} />);
      const input = screen.getByRole("textbox", { name: "Clipped instructions" }) as HTMLTextAreaElement;
      await userEvent.fill(input, "@rev");
      const popup = screen.getByRole("listbox", { name: "Skill suggestions" });
      const option = screen.getByRole("option", { name: "review Review changes Skill" });
      const reference = screen.getByTestId("theme-reference");
      expect(popup.parentElement).toBe(document.body);
      expect(option).toHaveAttribute("tabindex", "-1");
      expect(popup).not.toHaveAttribute("popover");
      expect(getComputedStyle(popup).backgroundColor).toBe(getComputedStyle(reference).backgroundColor);
      expect(getComputedStyle(popup.querySelector("svg")!).color).toBe(getComputedStyle(reference).color);
      expect(getComputedStyle(popup).fontFamily).toBe(getComputedStyle(input).fontFamily);
      const popupRect = popup.getBoundingClientRect();
      expect(popupRect.width).toBeCloseTo(input.getBoundingClientRect().width, 0);
      expect(popupRect.top).toBeLessThan(screen.getByRole("dialog").getBoundingClientRect().top);
      expect(popupRect.top).toBeGreaterThanOrEqual(0);
      expect(popupRect.right).toBeLessThanOrEqual(window.innerWidth);
      expect(popupRect.bottom).toBeLessThanOrEqual(window.innerHeight);
      await userEvent.click(option);
      expect(input).toHaveValue("@review ");
      expect(document.activeElement).toBe(input);
      expect(onOutside).not.toHaveBeenCalled();
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Last setting" }));
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(input);
    } finally {
      view?.unmount();
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "showPopover", descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
    }
  });

  it("completes an enabled selected-folder skill without changing the suffix or native caret", async () => {
    const onChange = vi.fn();
    const view = render(<Fixture initial="Use @re then continue" onChange={onChange} />);
    const input = screen.getByRole("textbox", { name: "System instructions" }) as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(7, 7);
    fireEvent.select(input);
    expect(screen.getByRole("listbox", { name: "Skill suggestions" })).toBeVisible();
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "releaseRelease checksSkill", "reviewReview changesSkill",
    ]);
    expect(input).toHaveAttribute("aria-controls", screen.getByRole("listbox").id);
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(input).toHaveValue("Use @review  then continue");
    expect(onChange).toHaveBeenLastCalledWith("Use @review  then continue");
    expect(input.selectionStart).toBe(12);
    expect(input.selectionEnd).toBe(12);
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("listbox")).toBeNull();
    const token = view.container.querySelector<HTMLElement>(".skill-prompt-token")!;
    expect(token).toHaveTextContent("@review");
    expect(getComputedStyle(token).color).not.toBe(getComputedStyle(input).color);
    expect(view.container.querySelector(".skill-prompt-highlight")).toHaveAttribute("aria-hidden", "true");
    await userEvent.keyboard("{ArrowLeft}{Backspace}");
    expect(input).toHaveValue("Use @revie  then continue");
  });

  it("preserves newlines, ignores IME selection, dismisses with Escape, and keeps Tab navigation native", async () => {
    render(<><Fixture /><input aria-label="Next control" /></>);
    const input = screen.getByRole("textbox", { name: "System instructions" });
    await userEvent.fill(input, "@re");
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: true });
    expect(input).toHaveValue("@re");
    expect(screen.getByRole("listbox")).toBeVisible();
    fireEvent.compositionStart(input);
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("@re");
    fireEvent.compositionEnd(input);
    expect(screen.getByRole("listbox")).toBeVisible();
    await userEvent.keyboard("{Escape}{Shift>}{Enter}{/Shift}");
    expect(input).toHaveValue("@re\n");
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Next control" }));
  });

  it("supports mouse completion, Tab completion and excludes unavailable names and email/path text", async () => {
    const view = render(<Fixture />);
    const input = screen.getByRole("textbox", { name: "System instructions" });
    await userEvent.fill(input, "@");
    expect(screen.getAllByRole("option")).toHaveLength(2);
    await userEvent.click(screen.getByRole("option", { name: "review Review changes Skill" }));
    expect(input).toHaveValue("@review ");
    await userEvent.fill(input, "@rel");
    await userEvent.keyboard("{Tab}");
    expect(input).toHaveValue("@release ");
    for (const text of ["mail@review", "@review.md", "@review/path", "@disabled", "@review_longer"]) {
      await userEvent.fill(input, text);
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(view.container.querySelector(".skill-prompt-token")).toBeNull();
    }
  });

  it("keeps wrapping and scroll geometry aligned for long instructions at narrow width and zoom", async () => {
    await page.viewport(430, 700);
    const text = Array.from({ length: 30 }, (_, index) => `Line ${index}: @review, preserve carets and wrap ${"longword".repeat(8)}.`).join("\n") + "\n";
    const view = render(<Fixture initial={text} width={310} zoom={1.25} />);
    const input = screen.getByRole("textbox", { name: "System instructions" }) as HTMLTextAreaElement;
    const highlight = view.container.querySelector<HTMLDivElement>(".skill-prompt-highlight")!;
    await waitFor(() => expect(highlight.scrollHeight).toBeGreaterThan(input.clientHeight));
    const assertAlignment = () => {
      const inputRect = input.getBoundingClientRect();
      const highlightRect = highlight.getBoundingClientRect();
      expect(highlightRect.left).toBeCloseTo(inputRect.left, 0);
      expect(highlightRect.top).toBeCloseTo(inputRect.top, 0);
      expect(highlightRect.width).toBeCloseTo(inputRect.width, 0);
      expect(highlightRect.height).toBeCloseTo(inputRect.height, 0);
      expect(Math.abs(highlight.scrollHeight - input.scrollHeight)).toBeLessThanOrEqual(2);
      for (const property of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingLeft", "paddingTop"] as const) {
        expect(getComputedStyle(highlight)[property]).toBe(getComputedStyle(input)[property]);
      }
      expect(getComputedStyle(highlight).pointerEvents).toBe("none");
    };
    assertAlignment();
    input.scrollTop = input.scrollHeight;
    fireEvent.scroll(input);
    expect(highlight.scrollTop).toBe(input.scrollTop);
    view.rerender(<Fixture initial={text} width={245} zoom={1.25} font="mono" />);
    await waitFor(assertAlignment);
    expect(highlight.scrollTop).toBe(input.scrollTop);
    input.style.height = "178px";
    await waitFor(() => expect(highlight.getBoundingClientRect().height).toBeCloseTo(input.getBoundingClientRect().height, 0));
    assertAlignment();
    input.focus();
    input.setSelectionRange(text.length, text.length);
    await userEvent.keyboard("Tail");
    expect(input.value).toBe(`${text}Tail`);
    await userEvent.keyboard(" @rev");
    const popup = screen.getByRole("listbox");
    const popupRect = popup.getBoundingClientRect();
    expect(popupRect.top).toBeGreaterThanOrEqual(0);
    expect(popupRect.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(popupRect.left).toBeGreaterThanOrEqual(0);
    expect(popupRect.right).toBeLessThanOrEqual(window.innerWidth);
    await userEvent.click(screen.getByRole("option", { name: "review Review changes Skill" }));
    expect(input.value).toBe(`${text}Tail @review `);
  });

  it("keeps autocomplete and highlighting usable with reduced motion", async () => {
    await commands.setStreamTestReducedMotion(true);
    const view = render(<Fixture />);
    const input = screen.getByRole("textbox", { name: "System instructions" });
    await userEvent.fill(input, "@rev");
    expect(screen.getByRole("listbox").getAnimations()).toHaveLength(0);
    await userEvent.keyboard("{Enter}");
    expect(input).toHaveValue("@review ");
    expect(view.container.querySelector(".skill-prompt-token")).toHaveTextContent("@review");
  });
});
