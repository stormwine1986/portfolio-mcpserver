import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env as workerEnv } from "cloudflare:workers";
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
			outputSchema: z.object({
				fields: z.array(
					z.object({
						name: z.string(),
						value: z.string(),
						description: z.string(),
					}),
				),
			}),
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

				const output = {
					fields: [
						{
							name: "btcusd",
							value: price.toFixed(2),
							description: "BTC现货价格，以 USD 计价",
						},
					],
				};

				return {
					content: [{ type: "text", text: JSON.stringify(output) }],
					structuredContent: output,
				};
			} catch {
				return {
					content: [{ type: "text", text: "获取 BTC/USD 实时价格失败，请稍后重试。" }],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"get_asserts_status",
		{
			description: "获取资产总计，以 CNY 计价。",
			inputSchema: z.object({}),
			outputSchema: z.object({
				fields: z.array(
					z.object({
						name: z.string(),
						value: z.string(),
						description: z.string(),
					}),
				),
			}),
		},
		async () => {
			try {
				const database = workerEnv.DB;
				const { results } = await database
					.prepare(
						"SELECT symbol, COALESCE(SUM(shares * market_price), 0) AS amount FROM assets GROUP BY symbol",
					)
					.all<{ symbol: string | null; amount: number }>();

				const totals = new Map<string, number>();
				for (const row of results) {
					if (!row.symbol || !["CNY", "USD", "BTC"].includes(row.symbol)) {
						throw new Error("Assets contain an unsupported currency symbol");
					}
					totals.set(row.symbol, row.amount);
				}

				let totalCny = totals.get("CNY") ?? 0;
				const usdTotal = totals.get("USD") ?? 0;
				const btcTotal = totals.get("BTC") ?? 0;

				if (usdTotal !== 0 || btcTotal !== 0) {
					const fxResponse = await fetch("https://api.frankfurter.app/latest?from=USD&to=CNY", {
						cache: "no-store",
					});
					if (!fxResponse.ok) {
						throw new Error(`Frankfurter returned HTTP ${fxResponse.status}`);
					}
					const fxResult = z
						.object({ rates: z.object({ CNY: z.number().positive() }) })
						.parse(await fxResponse.json());
					const usdCny = fxResult.rates.CNY;
					totalCny += usdTotal * usdCny;

					if (btcTotal !== 0) {
						const btcResponse = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot", {
							cache: "no-store",
						});
						if (!btcResponse.ok) {
							throw new Error(`Coinbase returned HTTP ${btcResponse.status}`);
						}
						const btcResult = z
							.object({
								data: z.object({
									amount: z.string(),
									base: z.literal("BTC"),
									currency: z.literal("USD"),
								}),
							})
							.parse(await btcResponse.json());
						const btcUsd = Number(btcResult.data.amount);
						if (!Number.isFinite(btcUsd) || btcUsd <= 0) {
							throw new Error("Coinbase returned an invalid BTC price");
						}
						totalCny += btcTotal * btcUsd * usdCny;
					}
				}

				if (!Number.isFinite(totalCny)) {
					throw new Error("Asset total is not finite");
				}

				const output = {
					fields: [
						{
							name: "total",
							value: totalCny.toFixed(2),
							description: "资产总计，以CNY计价",
						},
					],
				};

				return {
					content: [{ type: "text", text: JSON.stringify(output) }],
					structuredContent: output,
				};
			} catch {
				return {
					content: [{ type: "text", text: "获取资产总计失败，请检查数据库或汇率服务后重试。" }],
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
