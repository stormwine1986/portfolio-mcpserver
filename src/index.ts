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
		"get_usdcny_value",
		{
			description: "获取美元对人民币的当前汇率。",
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
				const response = await fetch("https://api.frankfurter.app/latest?from=USD&to=CNY", {
					cache: "no-store",
				});

				if (!response.ok) {
					throw new Error(`Frankfurter returned HTTP ${response.status}`);
				}

				const result = z
					.object({ rates: z.object({ CNY: z.number().positive() }) })
					.parse(await response.json());
				const output = {
					fields: [
						{
							name: "usdcny",
							value: result.rates.CNY.toFixed(2),
							description: "美元对人民币汇率",
						},
					],
				};

				return {
					content: [{ type: "text", text: JSON.stringify(output) }],
					structuredContent: output,
				};
			} catch {
				return {
					content: [{ type: "text", text: "获取美元/人民币汇率失败，请稍后重试。" }],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"list_assets",
		{
			description: "列出所有资产名称。",
			inputSchema: z.object({}),
			outputSchema: z.object({ assets: z.array(z.string()) }),
		},
		async () => {
			try {
				const { results } = await workerEnv.DB.prepare(
					"SELECT name FROM assets ORDER BY name",
				).all<{ name: string }>();
				const output = { assets: results.map((row) => row.name) };

				return {
					content: [{ type: "text", text: JSON.stringify(output) }],
					structuredContent: output,
				};
			} catch {
				return {
					content: [{ type: "text", text: "获取资产名称列表失败，请检查数据库后重试。" }],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"get_asserts_status",
		{
			description: "获取资产组合的状态，包括资产总值等",
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
						"SELECT symbol, COALESCE(SUM(shares * market_price), 0) AS amount, COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM tags WHERE tags.name = assets.name AND tags.label = ?) THEN shares * market_price ELSE 0 END), 0) AS risk_amount FROM assets GROUP BY symbol",
					)
					.bind("风险资产")
					.all<{ symbol: string | null; amount: number; risk_amount: number }>();

				const totals = new Map<string, { amount: number; riskAmount: number }>();
				for (const row of results) {
					if (!row.symbol || !["CNY", "USD", "BTC"].includes(row.symbol)) {
						throw new Error("Assets contain an unsupported currency symbol");
					}
					totals.set(row.symbol, { amount: row.amount, riskAmount: row.risk_amount });
				}

				let totalCny = totals.get("CNY")?.amount ?? 0;
				let riskTotalCny = totals.get("CNY")?.riskAmount ?? 0;
				const usdTotal = totals.get("USD")?.amount ?? 0;
				const usdRiskTotal = totals.get("USD")?.riskAmount ?? 0;
				const btcTotal = totals.get("BTC")?.amount ?? 0;
				const btcRiskTotal = totals.get("BTC")?.riskAmount ?? 0;

				if (usdTotal !== 0 || usdRiskTotal !== 0 || btcTotal !== 0 || btcRiskTotal !== 0) {
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
					riskTotalCny += usdRiskTotal * usdCny;

					if (btcTotal !== 0 || btcRiskTotal !== 0) {
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
						riskTotalCny += btcRiskTotal * btcUsd * usdCny;
					}
				}

				if (!Number.isFinite(totalCny) || !Number.isFinite(riskTotalCny)) {
					throw new Error("Asset total is not finite");
				}

				const output = {
					fields: [
						{
							name: "total",
							value: totalCny.toFixed(2),
							description: "资产总计，以CNY计价",
						},
						{
							name: "risk_exposure",
							value: `${(totalCny === 0 ? 0 : (riskTotalCny / totalCny) * 100).toFixed(2)}%`,
							description: "风险资产总值占资产总值的比例",
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

	server.registerTool(
		"upsert_asset",
		{
			description: "按资产名称创建或更新资产；更新时只修改提供的字段，不修改标签。",
			inputSchema: z.object({
				name: z.string().trim().min(1),
				shares: z.number().finite().optional(),
				avg_cost_price: z.number().finite().optional(),
				market_price: z.number().finite().optional(),
				symbol: z.enum(["CNY", "USD", "BTC"]).nullable().optional(),
				role: z.enum(["流动性", "生息", "养老", "保险"]).nullable().optional(),
				remarks: z.string().nullable().optional(),
				interest_rate: z.number().finite().nullable().optional(),
			}),
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
		async ({
			name,
			shares,
			avg_cost_price,
			market_price,
			symbol,
			role,
			remarks,
			interest_rate,
		}) => {
			try {
				const now = new Date();
				const updatedAt = new Date(now.getTime() + 8 * 60 * 60 * 1000)
					.toISOString()
					.replace("T", " ")
					.slice(0, 19);
				const insertColumns = ["name", "shares", "avg_cost_price", "market_price", "updated_at"];
				const values: (string | number | null)[] = [
					name,
					shares ?? 0,
					avg_cost_price ?? 1,
					market_price ?? 1,
					updatedAt,
				];
				const updateColumns = ["updated_at"];

				if (shares !== undefined) updateColumns.push("shares");
				if (avg_cost_price !== undefined) updateColumns.push("avg_cost_price");
				if (market_price !== undefined) updateColumns.push("market_price");

				const optionalFields = [
					{ column: "symbol", value: symbol },
					{ column: "Role", value: role },
					{ column: "remarks", value: remarks },
					{ column: "interest_rate", value: interest_rate },
				];
				for (const { column, value } of optionalFields) {
					if (value !== undefined) {
						insertColumns.push(column);
						updateColumns.push(column);
						values.push(value);
					}
				}

				const quoteColumn = (column: string) => `"${column}"`;
				const assignments = updateColumns
					.map((column) => `${quoteColumn(column)} = excluded.${quoteColumn(column)}`)
					.join(", ");
				await workerEnv.DB.prepare(
					`INSERT INTO assets (${insertColumns.map(quoteColumn).join(", ")}) VALUES (${insertColumns.map(() => "?").join(", ")}) ON CONFLICT(name) DO UPDATE SET ${assignments}`,
				)
					.bind(...values)
					.run();

				const output = {
					fields: [
						{ name: "name", value: name, description: "资产名称" },
						{ name: "updated_at", value: updatedAt, description: "最后更新时间（UTC+8）" },
						{ name: "result", value: "upserted", description: "资产已创建或更新" },
					],
				};

				return {
					content: [{ type: "text", text: JSON.stringify(output) }],
					structuredContent: output,
				};
			} catch {
				return {
					content: [{ type: "text", text: "创建或更新资产失败，请检查数据库后重试。" }],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"create_baseline",
		{
			description: "创建或更新当日资产基线，总值以 CNY 计价。",
			inputSchema: z.object({ total: z.number().finite() }),
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
		async ({ total }) => {
			try {
				const now = new Date();
				const baseline = now.toISOString().slice(0, 10).replaceAll("-", "");
				const createdAt = new Date(now.getTime() + 8 * 60 * 60 * 1000)
					.toISOString()
					.replace("T", " ")
					.slice(0, 19);

				await workerEnv.DB.prepare(
					"INSERT INTO baseline (baseline, total, created_at) VALUES (?, ?, ?) ON CONFLICT(baseline) DO UPDATE SET total = excluded.total, created_at = excluded.created_at",
				)
					.bind(baseline, total, createdAt)
					.run();

				const output = {
					fields: [
						{ name: "baseline", value: baseline, description: "基线标识" },
						{ name: "total", value: total.toFixed(2), description: "资产总值，CNY计价" },
						{ name: "created_at", value: createdAt, description: "基线创建时间" },
					],
				};

				return {
					content: [{ type: "text", text: JSON.stringify(output) }],
					structuredContent: output,
				};
			} catch {
				return {
					content: [{ type: "text", text: "创建资产基线失败，请检查数据库后重试。" }],
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
