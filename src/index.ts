import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

function createServer() {
	const server = new McpServer({
		name: "Portfolio Manage Tools",
		version: "1.0.0",
	});

	server.registerTool(
		"add",
		{ inputSchema: z.object({ a: z.number(), b: z.number() }) },
		async ({ a, b }) => ({
			content: [{ type: "text", text: String(a + b) }],
		}),
	);

	server.registerTool(
		"get_btcusd_value",
		{
			description: "获取 BTC 的当前现货价格，以 USD 计价。",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const response = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot", {
					cache: "no-store",
				});

				if (!response.ok) {
					throw new Error(`Coinbase returned HTTP ${response.status}`);
				}

				const result = z
					.object({
						data: z.object({
							amount: z.string(),
							base: z.literal("BTC"),
							currency: z.literal("USD"),
						}),
					})
					.parse(await response.json());
				const price = Number(result.data.amount);

				if (!Number.isFinite(price) || price <= 0) {
					throw new Error("Coinbase returned an invalid BTC price");
				}

				return {
					content: [
						{
							type: "text",
							text: `BTC/USD 现货价格：${new Intl.NumberFormat("en-US", {
								style: "currency",
								currency: "USD",
								maximumFractionDigits: 8,
							}).format(price)}`,
						},
					],
				};
			} catch {
				return {
					content: [{ type: "text", text: "获取 BTC/USD 实时价格失败，请稍后重试。" }],
					isError: true,
				};
			}
		},
	);

	return server;
}

const handler = createMcpHandler(createServer);

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return handler(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
