import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import type { AppConfig } from "./config.js";
import { SERVICE_VERSION, WORKERS, type WorkerId } from "./constants.js";
import { catalog, workerContracts, workerPrice } from "./discovery.js";

const WORKER_IDS = Object.values(WORKERS).map((worker) => worker.id) as [
  WorkerId,
  ...WorkerId[],
];

function findWorker(id: WorkerId) {
  const worker = Object.values(WORKERS).find((item) => item.id === id);
  if (!worker) throw new Error("Unknown worker");
  return worker;
}

export function createDiemMcpServer(config: AppConfig): McpServer {
  const server = new McpServer(
    { name: "diem-agent-workers", version: SERVICE_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  // The SDK's schema-to-handler generic is intentionally bypassed here. With
  // six large JSON Schemas, fully expanding that inference makes TypeScript
  // consume excessive memory without adding runtime validation beyond Zod.
  const registerTool = server.registerTool.bind(server) as unknown as (
    name: string,
    definition: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => unknown;
  const registerResource = server.registerResource.bind(server) as unknown as (
    name: string,
    uri: string,
    definition: Record<string, unknown>,
    handler: (uri: URL) => Promise<Record<string, unknown>>,
  ) => unknown;

  registerTool(
    "list_diem_workers",
    {
      title: "List DIEM Agent Workers",
      description:
        "List bounded x402-paid workers, exact USDC prices, schemas, limits, and endpoints. This tool is free.",
      inputSchema: {},
    },
    async () => {
      const result = catalog(config) as Record<string, unknown>;
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  registerTool(
    "quote_diem_worker",
    {
      title: "Quote a DIEM Agent Worker",
      description: "Return a free exact-price x402 USDC quote for one worker.",
      inputSchema: { worker: z.enum(WORKER_IDS) },
    },
    async (args) => {
      const worker = args.worker as WorkerId;
      const definition = findWorker(worker);
      const result = {
        worker,
        endpoint: `${config.publicBaseUrl}${definition.path}`,
        price: {
          amount: workerPrice(config, worker).toFixed(3),
          currency: "USDC",
          protocol: "x402",
          exact: true,
        },
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  registerTool(
    "prepare_diem_worker_call",
    {
      title: "Prepare a DIEM Worker Call",
      description:
        "Validate worker selection and return the exact HTTP request shape. Execute it with an x402-capable client or through the CDP Bazaar MCP server; this server never receives wallet private keys.",
      inputSchema: {
        worker: z.enum(WORKER_IDS),
        input: z.record(z.string(), z.unknown()),
      },
    },
    async (args) => {
      const worker = args.worker as WorkerId;
      const input = args.input as Record<string, unknown>;
      const definition = findWorker(worker);
      const result = {
        method: "POST",
        url: `${config.publicBaseUrl}${definition.path}`,
        headers: { "content-type": "application/json" },
        body: input,
        inputSchema: workerContracts[worker].inputSchema,
        priceUsd: workerPrice(config, worker).toFixed(3),
        payment: "x402 exact USDC; the first unpaid request returns payment instructions",
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  registerResource(
    "diem-worker-catalog",
    `${config.publicBaseUrl}/v1/catalog`,
    { mimeType: "application/json", description: "Live DIEM Agent Workers catalog" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(catalog(config)),
        },
      ],
    }),
  );

  return server;
}

export async function handleMcpRequest(
  config: AppConfig,
  req: Request,
  res: Response,
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Method not allowed" },
    });
    return;
  }
  const server = createDiemMcpServer(config);
  const transport = new StreamableHTTPServerTransport({});
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport as unknown as Parameters<McpServer["connect"]>[0]);
    await transport.handleRequest(req, res, req.body);
  } catch {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "Internal error" },
      });
    }
  }
}

export async function runMcpStdio(config: AppConfig): Promise<void> {
  const server = createDiemMcpServer(config);
  await server.connect(new StdioServerTransport());
}
