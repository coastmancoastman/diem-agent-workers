#!/usr/bin/env node
import "dotenv/config";
import { loadConfig } from "./config.js";
import { runMcpStdio } from "./mcp.js";

runMcpStdio(loadConfig()).catch(() => {
  process.stderr.write("DIEM MCP server failed to start\n");
  process.exitCode = 1;
});
