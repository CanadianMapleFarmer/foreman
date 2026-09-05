#!/usr/bin/env bun
import { VERSION } from "./version";

const command = process.argv[2] ?? "mcp";
if (command === "--version") {
  console.log(VERSION);
  process.exit(0);
}
console.error(`unknown command: ${command}`);
process.exit(2);
