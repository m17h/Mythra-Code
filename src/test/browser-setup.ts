import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Deliberately minimal: unlike the jsdom setup this must not stub
 * `ResizeObserver`, because the specs in this project exist to observe real
 * layout measurement. Cleanup is registered explicitly since Testing Library's
 * automatic teardown does not self-register without global test APIs.
 */
afterEach(cleanup);
