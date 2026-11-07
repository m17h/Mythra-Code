import test from "node:test";
import assert from "node:assert/strict";
import { hostLinkPath, hostLocalPort, isLocalTunnelUrl } from "./links.ts";

test("a preview keeps the page and query of the link that opened it", () => {
  assert.equal(hostLinkPath("http://localhost:3000/settings/profile?tab=keys&x=1"), "/settings/profile?tab=keys&x=1");
  assert.equal(hostLinkPath("http://127.0.0.1:8080/a%20b"), "/a%20b");
});

test("the root needs no path at all", () => {
  assert.equal(hostLinkPath("http://localhost:3000"), undefined);
  assert.equal(hostLinkPath("http://localhost:3000/"), undefined);
});

test("a fragment never reaches the tunnel, because browsers never send one", () => {
  assert.equal(hostLinkPath("http://localhost:3000/docs#install"), "/docs");
  assert.equal(hostLinkPath("http://localhost:3000/#top"), undefined);
});

test("paths the host would refuse fall back to the root", () => {
  assert.equal(hostLinkPath(`http://localhost:3000/${"a".repeat(9000)}`), undefined);
  assert.equal(hostLinkPath("http://localhost:3000//evil.example/path"), undefined);
  assert.equal(hostLinkPath("not a url"), undefined);
});

test("hostLocalPort still means only the other machine's own addresses", () => {
  assert.equal(hostLocalPort("http://localhost:3000/a"), 3000);
  assert.equal(hostLocalPort("http://example.com:3000/a"), null);
});

test("only this device's own tunnel is offered as an address to paste", () => {
  assert.equal(isLocalTunnelUrl("http://127.0.0.1:49999/"), true);
  assert.equal(isLocalTunnelUrl("http://p-abc123.localhost:49999/"), true);
  assert.equal(isLocalTunnelUrl("http://P-ABC.LOCALHOST:49999/x"), true);
  assert.equal(isLocalTunnelUrl("https://p-abc.localhost:49999/"), false);
  assert.equal(isLocalTunnelUrl("http://p-abc.localhost.example.com:49999/"), false);
  assert.equal(isLocalTunnelUrl("http://example.com:49999/"), false);
  assert.equal(isLocalTunnelUrl("http://user:pw@p-abc.localhost:49999/"), false);
  assert.equal(isLocalTunnelUrl("http://127.0.0.1/"), false);
  assert.equal(isLocalTunnelUrl(undefined), false);
});
