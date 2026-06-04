import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_TIMEOUT_MS, getCopilotStatus } from "./quota.js";

const _require = createRequire(import.meta.url);
const { version } = _require("../package.json") as { version: string };

const TOOL_NAME = "get_copilot_status";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function parseArguments(value: unknown): { timeoutMs?: number; includeLogin?: boolean } | undefined {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) return undefined;

  const { timeoutMs, includeLogin } = value;
  if (timeoutMs !== undefined && typeof timeoutMs !== "number") return undefined;
  if (includeLogin !== undefined && typeof includeLogin !== "boolean") return undefined;

  return { timeoutMs, includeLogin };
}

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    { name: "copilot-status-mcp", version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL_NAME,
        description:
          "Retrieve GitHub Copilot quota and rate-limit status: " +
          "whether the 5-hour session window is exhausted and when it resets, " +
          "weekly window usage, and monthly quota for chat, completions, and premium models.",
        inputSchema: {
          type: "object",
          properties: {
            timeoutMs: {
              type: "number",
              description: `Timeout in milliseconds for API requests. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
            },
            includeLogin: {
              type: "boolean",
              description: "Include the GitHub login in the response. Defaults to false.",
            },
          },
          additionalProperties: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== TOOL_NAME) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }

    const args = parseArguments(request.params.arguments);
    if (!args) {
      return {
        content: [{ type: "text", text: "Invalid arguments: timeoutMs must be a number and includeLogin must be a boolean." }],
        isError: true,
      };
    }

    try {
      const result = await getCopilotStatus(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
