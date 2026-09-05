import { expect, test } from "bun:test";
import { AcpHost } from "../src/acp-host";

const host = () => new AcpHost({ command: ["bun", "run", `${import.meta.dir}/fake-agent.ts`] });
const allowAll = { onPermission: () => ({ allow: true, reason: "test" }) };
const denyAll = { onPermission: () => ({ allow: false, reason: "test" }) };

test("start, new session, prompt collects chunks and usage", async () => {
  const h = host(); await h.start();
  const sid = await h.newSession("/tmp");
  const r = await h.prompt(sid, "hello", allowAll, 5000);
  expect(r.stopReason).toBe("end_turn");
  expect(r.text).toBe("PONG");
  expect(r.usage?.totalTokens).toBe(110);
  h.close();
});

test("setModel verifies the read-back value", async () => {
  const h = host(); await h.start();
  const sid = await h.newSession("/tmp");
  await h.setModel(sid, "openrouter/z-ai/glm-5.3-flash");
  await expect(h.setModel(sid, "bad/model")).rejects.toThrow(/unknown model/);
  h.close();
});

test("permission requests are answered by the handler and counted", async () => {
  const h = host(); await h.start();
  const sid = await h.newSession("/tmp");
  const granted = await h.prompt(sid, "PERMISSION", allowAll, 5000);
  expect(granted.text).toBe("granted");
  expect(granted.rejections).toBe(0);
  const denied = await h.prompt(sid, "PERMISSION", denyAll, 5000);
  expect(denied.text).toBe("denied");
  expect(denied.rejections).toBe(1);
  h.close();
});

test("diff updates populate filesChanged", async () => {
  const h = host(); await h.start();
  const sid = await h.newSession("/tmp");
  const r = await h.prompt(sid, "DIFF", allowAll, 5000);
  expect(r.filesChanged).toEqual(["src/x.ts"]);
  h.close();
});

test("timeout cancels the turn", async () => {
  const h = host(); await h.start();
  const sid = await h.newSession("/tmp");
  const r = await h.prompt(sid, "SLOW", allowAll, 400);
  expect(r.stopReason).toBe("timeout");
  h.close();
});

test("child crash rejects the turn and isAlive turns false", async () => {
  const h = host(); await h.start();
  const sid = await h.newSession("/tmp");
  await expect(h.prompt(sid, "CRASH", allowAll, 5000)).rejects.toThrow(/exited/);
  expect(h.isAlive()).toBe(false);
});

test("usage_update cost and context size are captured", async () => {
  const h = host(); await h.start();
  const sid = await h.newSession("/tmp");
  const r = await h.prompt(sid, "COST", allowAll, 5000);
  expect(r.reportedCostUsd).toBeCloseTo(0.0123);
  expect(r.contextTokens).toBe(5000);
  const plain = await h.prompt(sid, "hello", allowAll, 5000);
  expect(plain.reportedCostUsd).toBeNull();
  h.close();
});
