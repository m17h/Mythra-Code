import { render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { AnimatedMythraLogo } from "./AnimatedMythraLogo";
import "../styles.css";

afterEach(async () => {
  await commands.setStreamTestReducedMotion(false);
  await page.viewport(1400, 900);
});

// Exercise the actual welcome-panel classes and logo inside their real flex
// boundary. Fixed available dimensions model the space left by the topbar,
// sidebar, composer, and larger UI scale without mocking browser geometry.
function WelcomePanel({ width, height, chat = false, handoff = false }: {
  width: number; height: number; chat?: boolean; handoff?: boolean;
}) {
  return (
    <div style={{ width, height, display: "flex", flexDirection: "column" }}>
      <div className="conversation">
        <section className="thread-empty-state" data-testid="welcome">
          {handoff && <div className="handoff-draft-banner"><span><strong>Provider handoff ready</strong><small>Review the visible context before sending it to the next provider.</small></span></div>}
          <AnimatedMythraLogo />
          <h1>{chat ? "Start a normal chat." : "What should we build?"}</h1>
          <p>{chat ? "This conversation is not attached to any project folder. Ask a question, brainstorm, or work without repository context." : "This thread works inside Mythra Code. Commands and file changes start in that project folder."}</p>
          <div className="trust-strip"><span>No app-added system prompt</span><span>{chat ? "No project folder" : "Local project access"}</span><span>Approval controls</span></div>
          {!chat && <>
            <div className="isolation-choice"><button><span><strong>Shared project</strong><small>Work directly in Mythra Code</small></span></button><button><span><strong>Isolated worktree</strong><small>Private branch; apply or<br />merge when ready</small></span></button></div>
            <div className="empty-state-actions"><button>Browse files</button><button>Terminal</button><button>Review changes</button></div>
          </>}
        </section>
      </div>
    </div>
  );
}

it.each([
  { width: 710, height: 350, chat: false, handoff: false },
  { width: 560, height: 280, chat: true, handoff: false },
  { width: 510, height: 300, chat: false, handoff: true },
])("keeps every welcome item reachable in a constrained panel ($chat, $handoff)", async (props) => {
  await page.viewport(980, 680);
  await commands.setStreamTestReducedMotion(true);
  const view = render(<WelcomePanel {...props} />);
  const panel = view.getByTestId("welcome");
  const first = panel.firstElementChild!;
  const last = panel.lastElementChild!;
  expect(panel.getBoundingClientRect().height).toBeLessThanOrEqual(props.height);
  expect(first.getBoundingClientRect().top).toBeGreaterThanOrEqual(panel.getBoundingClientRect().top);
  expect(getComputedStyle(panel).overflowY).toBe("auto");
  panel.scrollTop = panel.scrollHeight;
  await expect.poll(() => last.getBoundingClientRect().bottom).toBeLessThanOrEqual(panel.getBoundingClientRect().bottom);
  panel.scrollTop = 0;
  expect(first.getBoundingClientRect().top).toBeGreaterThanOrEqual(panel.getBoundingClientRect().top);
});

it("retains balanced centering when all welcome controls fit", async () => {
  await commands.setStreamTestReducedMotion(true);
  const view = render(<WelcomePanel width={1080} height={700} />);
  const panel = view.getByTestId("welcome");
  expect(panel.scrollHeight).toBe(panel.clientHeight);
  const rect = panel.getBoundingClientRect();
  const topGap = panel.firstElementChild!.getBoundingClientRect().top - rect.top;
  const bottomGap = rect.bottom - panel.lastElementChild!.getBoundingClientRect().bottom;
  expect(topGap).toBeGreaterThan(32);
  expect(Math.abs(topGap - bottomGap)).toBeLessThan(1);
});
