import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
// Load the stylesheets in production order (main.tsx): legacy styles.css
// first, then the Lumen redesign. Specs that import "../styles.css" again get
// the already-loaded module, so the order cannot flip back. With this order the
// same-named @keyframes that Lumen re-choreographs resolve to Lumen's frames,
// exactly as in the shipped bundle.
import "../styles.css";
import "../styles/lumen/index.css";

/**
 * Deliberately minimal: unlike the jsdom setup this must not stub
 * `ResizeObserver`, because the specs in this project exist to observe real
 * layout measurement. Cleanup is registered explicitly since Testing Library's
 * automatic teardown does not self-register without global test APIs.
 */
afterEach(cleanup);
