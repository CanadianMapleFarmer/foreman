import { expect, test } from "bun:test";
import { VERSION } from "../src/version";

test("exposes a version", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
