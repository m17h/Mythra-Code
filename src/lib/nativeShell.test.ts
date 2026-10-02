// @ts-expect-error Node built-in types are unavailable to the frontend compiler.
import { execPath } from "node:process";
import { expect, it } from "vitest";
import { runNativeShellCommand } from "./nativeShell.testHelpers";

it("reports a native spawn error without waiting for the execution deadline", async () => {
  const result = await runNativeShellCommand(["mythra-nonexistent-test-executable"]);
  expect(result.error).toBeDefined();
  expect(result.status).toBeNull();
  expect(result.cleanupSucceeded).toBe(true);
});

it("fails and stops a native process that never exits", async () => {
  const result = await runNativeShellCommand([execPath, "-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 });
  expect(result.error?.message).toContain("Native command exceeded 100ms");
  expect(result.status).toBeNull();
  expect(result.cleanupSucceeded).toBe(true);
}, 6_000);
