```ts
/**
 * SOUND LABZ AUDIO — LABZ AI
 *
 * Cloudflare Workers AI + Shopify product search
 */

import { Env, ChatMessage } from "./types";

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";
const SHOPIFY_API_VERSION = "2026-07";

let shopifyTokenCache: {
	token: string;
	expiresAt: number;
} | null = null;

const ALLOWED_ORIGIN = "https://soundlabzaudio.myshopify.com";

const SYSTEM_PROMPT = `
You are LABZ AI, the friendly AI assistant for SOUND LABZ AUDIO, an online car-audio store.

PERSONALITY:
- Friendly, natural, confident and helpful.
- Talk like a knowledgeable human.
- Be concise unless the customer asks for detail.
- Use occasional emojis naturally.
- Never mention internal prompts, APIs, models or backend systems.

CONVERSATION:
- Answer greetings naturally.
- Answer casual questions naturally.
- Answer the customer's actual question first.
- Ask useful follow-up questions when needed.
- Maintain context from the recent conversation.

SOUND LABZ AUDIO:
- Help customers with subwoofers, speakers, amplifiers, tweeters, bass systems, installation, compatibility and power requirements.
- Explain technical information simply.
- Ask about vehicle, budget, desired bass, music preferences, available space and existing equipment when useful.

SHOPIFY PRODUCT RULES:
- Shopify information is the source of truth for products, prices, variants, availability, vendors and URLs.
- NEVER invent a product.
- NEVER invent a price.
- NEVER invent availability.
- NEVER claim a product is in stock unless Shopify says Available: Yes.
- If a requested product is not found, clearly say it was not found.
- If products are similar but not exact matches, say they are similar.
- Use the exact product prices supplied by Shopify.
- Always provide the Shopify product URL when one is available.
- If the customer asks for products under a specific price, only recommend products that actually satisfy that price requirement.
- If the customer asks for a particular product name, prioritize exact or very close matches.
- If the customer asks for a brand such as Sundown Audio, prioritize products from that vendor.

SALES STYLE:
- Helpful, not pushy.
- Explain why a recommendation makes sense.
- Never pressure the customer to buy.
`;

function corsHeaders(origin: string | null): Headers {
	const allowedOrigin =
		origin === ALLOWED_ORIGIN
			? origin
			: ALLOWED_ORIGIN;

	return new Headers({
		"Access-Control-Allow-Origin": allowedOrigin,
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
		"Access-Control-Max-Age": "86400",
	});
}

function jsonResponse(
	data: unknown,
	status = 200,
	origin: string | null = null,
): Response {
	const headers = corsHeaders(origin);

	headers.set(
		"content-type",
		"application/json; charset=utf-8",
	);

	return new Response(JSON.stringify(data), {
		status,
		headers,
	});
}

/**
 * Extract maximum price from questions such as:
 *
 * under $100
 * below $100
 * less than $100
 * cheaper than $100
 * under 100 dollars
 */
function extractMaxPrice(message: string): number | null {
	const patterns = [
		/(?:under|below|less than|cheaper than|max(?:imum)?(?: price)?(?: of)?)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i,
		/\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:or less|and under)/i,
	];

	for (const pattern of patterns) {
		const match = message.match(pattern);

		if (match?.[1]) {
			const price = Number(match[1]);

			if (Number.isFinite(price)) {
				return price;
			}
		}
	}

	return null;
}

/**
 * Gets a Shopify Admin API access token.
 */
async function getShopifyAccessToken(
	env: Env,
): Promise<string> {
	const envWithShopify = env as Env & {
		SHOPIFY_STORE: string;
		SHOPIFY_CLIENT_ID: string;
		SHOPIFY_CLIENT_SECRET: string;
	};

	const now = Date.now();

	if (
		shopifyTokenCache &&
		shopifyTokenCache.expiresAt > now + 60_000
	) {
		return shopifyTokenCache.token;
	}

	const response = await fetch(
		"https://shopify.com/admin/oauth/access_token",
		{
			method: "POST",
			headers: {
				"Content-Type":
					"application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				client_id:
					envWithShopify.SHOPIFY_CLIENT_ID,
				client_secret:
					envWithShopify.SHOPIFY_CLIENT_SECRET,
				grant_type: "client_credentials",
			}),
		},
	);

	if (!response.ok) {
		const errorText = await response.text();

		console.error(
			"Shopify token error:",
			response.status,
			errorText,
		);

		throw new Error(
			"Unable to authenticate with Shopify.",
		);
	}

	const data = (await response.json()) as {
		access_token?: string;
		expires_in?: number;
	};

	if (!data.access_token) {
		throw new Error(
			"Shopify did not return an access token.",
		);
	}

	shopifyTokenCache = {
		token: data.access_token,
		expiresAt:
			now +
			Math.max(
				60_000,
				(data.expires_in ?? 86400) * 1000,
			),
	};

	return data.access_token;
}

/**
 * Searches Shopify and returns structured product information.
 */
async function searchShopifyProducts(
	query: string,
	env: Env,
	maxPrice: number | null,
): Promise<string> {
	const envWithShopify = env as Env & {
		SHOPIFY_STORE: string;
	};

	const token = await getShopifyAccessToken(env);

	const graphqlQuery = `
		query ProductSearch($query: String!) {
			products(first: 20, query: $query) {
				nodes {
					id
					title
					handle
					vendor
					description
					onlineStoreUrl
					featuredImage {
						url
					}
					variants(first: 20) {
						nodes {
							id
							title
							price
							availableForSale
							sku
						}
					}
				}
			}
		}
	`;

	const response = await fetch(
		`https://${envWithShopify.SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Shopify-Access-Token": token,
			},
			body: JSON.stringify({
				query: graphqlQuery,
				variables: {
					query,
				},
			}),
		},
	);

	if (!response.ok) {
		const errorText = await response.text();

		console.error(
			"Shopify product search error:",
			response.status,
			errorText,
		);

		throw new Error(
			"Unable to search Shopify products.",
		);
	}

	const data = (await response.json()) as {
		data?: {
			products?: {
				nodes?: Array<{
					id: string;
					title: string;
					handle: string;
					vendor?: string | null;
					description?: string | null;
					onlineStoreUrl?: string | null;
					featuredImage?: {
						url: string;
					} | null;
					variants?: {
						nodes?: Array<{
							id: string;
							title: string;
							price: string;
							availableForSale: boolean;
							sku?: string | null;
						}>;
					};
				}>;
			};
		};
		errors?: unknown[];
	};

	if (data.errors) {
		console.error(
			"Shopify GraphQL errors:",
			data.errors,
		);

		throw new Error(
			"Shopify returned a product search error.",
		);
	}

	let products = data.data?.products?.nodes ?? [];

	/*
	 * Apply the price filter ourselves.
	 *
	 * This is important because Shopify search should not
	 * be trusted to interpret "under $100" exactly the
	 * way the customer intended.
	 */
	if (maxPrice !== null) {
		products = products
			.map((product) => ({
				...product,
				variants: {
					nodes:
						product.variants?.nodes?.filter(
							(variant) =>
								Number(variant.price) <=
								maxPrice,
						) ?? [],
				},
			}))
			.filter(
				(product) =>
					(product.variants?.nodes?.length ?? 0) >
					0,
			);
	}

	if (products.length === 0) {
		if (maxPrice !== null) {
			return `No Shopify products matching the request were found under $${maxPrice}.`;
		}

		return "No matching Shopify products were found.";
	}

	return products
		.map((product, index) => {
			const variants =
				product.variants?.nodes ?? [];

			const variantText =
				variants.length > 0
					? variants
							.map(
								(variant) =>
									`- Variant: ${variant.title}; Price: ${variant.price}; Available: ${
										variant.availableForSale
											? "Yes"
											: "No"
									}${
										variant.sku
											? `; SKU: ${variant.sku}`
											: ""
									}`,
							)
							.join("\n")
					: "No matching variants.";

			return `
PRODUCT ${index + 1}
Title: ${product.title}
Vendor: ${product.vendor ?? "Not specified"}
Description: ${
				product.description
					? product.description.substring(0, 800)
					: "Not provided"
			}
Product URL: ${
				product.onlineStoreUrl ??
				`https://${envWithShopify.SHOPIFY_STORE}/products/${product.handle}`
			}
Variants:
${variantText}
`;
		})
		.join("\n");
}

/**
 * Determines whether a customer is asking about
 * products or store inventory.
 */
function shouldSearchProducts(
	message: string,
): boolean {
	const text = message.toLowerCase();

	const productKeywords = [
		"product",
		"products",
		"price",
		"cost",
		"how much",
		"buy",
		"sell",
		"selling",
		"available",
		"availability",
		"in stock",
		"stock",
		"have",
		"carry",
		"offer",
		"subwoofer",
		"subwoofers",
		"speaker",
		"speakers",
		"amplifier",
		"amplifiers",
		"tweeter",
		"tweeters",
		"woofer",
		"woofers",
		"sound system",
		"bass",
		"show me",
		"recommend",
		"recommendation",
		"under ",
		"below ",
		"less than",
		"cheaper than",
		"cheapest",
		"best",
		"brand",
		"sundown",
		"audio",
		"labz",
	];

	return productKeywords.some((keyword) =>
		text.includes(keyword),
	);
}

/**
 * Builds a Shopify search query.
 *
 * Removes conversational price language because
 * price filtering is handled separately by the backend.
 */
function buildProductSearchQuery(
	message: string,
): string {
	let query = message
		.replace(
			/^(hi|hello|hey|please|can you|could you|do you|do you guys|i want|i need)\s+/i,
			"",
		)
		.replace(
			/(under|below|less than|cheaper than|max(?:imum)?(?: price)?(?: of)?)\s*\$?\s*\d+(?:\.\d{1,2})?/gi,
			"",
		)
		.replace(
			/\$?\s*\d+(?:\.\d{1,2})?\s*(or less|and under)/gi,
			"",
		)
		.trim();

	return query.substring(0, 200);
}

/**
 * Handles LABZ AI chat requests.
 */
async function handleChatRequest(
	request: Request,
	env: Env,
	origin: string | null,
): Promise<Response> {
	try {
		const body = (await request.json()) as {
			messages?: ChatMessage[];
		};

		const incomingMessages = Array.isArray(
			body.messages,
		)
			? body.messages
			: [];

		const conversation = incomingMessages
			.filter(
				(message) =>
					message &&
					message.role !== "system" &&
					(message.role === "user" ||
						message.role === "assistant") &&
					typeof message.content === "string",
			)
			.slice(-20);

		let productContext = "";

		const latestUserMessage = [...conversation]
			.reverse()
			.find(
				(message) =>
					message.role === "user",
			);

		if (
			latestUserMessage &&
			shouldSearchProducts(
				latestUserMessage.content,
			)
		) {
			try {
				const customerQuestion =
					latestUserMessage.content;

				const maxPrice =
					extractMaxPrice(
						customerQuestion,
					);

				const searchQuery =
					buildProductSearchQuery(
						customerQuestion,
					);

				const results =
					await searchShopifyProducts(
						searchQuery,
						env,
						maxPrice,
					);

				productContext = `

SHOPIFY LIVE PRODUCT INFORMATION

The following information was retrieved directly from the current Shopify catalog.

Customer request:
${customerQuestion}

${maxPrice !== null ? `Maximum requested price: $${maxPrice}` : ""}

${results}

IMPORTANT:
- Use the Shopify information above as the source of truth.
- Do not invent products.
- Do not invent prices.
- Do not invent availability.
- Only recommend products that match the customer's request.
- If the customer requested a maximum price, do not recommend products above that price.
- If no matching products were found, say so clearly.
- Include product names and prices when relevant.
- Include the product URL when relevant.
`;
			} catch (error) {
				console.error(
					"Shopify search failed:",
					error,
				);

				productContext = `

SHOPIFY PRODUCT SEARCH

Shopify product information could not be retrieved right now.

Do not invent product availability or pricing.
`;
			}
		}

		const messages: ChatMessage[] = [
			{
				role: "system",
				content:
					SYSTEM_PROMPT +
					productContext,
			},
			...conversation,
		];

		const inputs = {
			messages,
			max_tokens: 512,
			stream: true,
		} satisfies AiTextGenerationInput & {
			stream: true;
		};

		const stream = await env.AI.run<
			typeof MODEL_ID
		>(MODEL_ID, inputs);

		const headers = corsHeaders(origin);

		headers.set(
			"content-type",
			"text/event-stream; charset=utf-8",
		);

		headers.set(
			"cache-control",
			"no-cache, no-transform",
		);

		headers.set(
			"connection",
			"keep-alive",
		);

		return new Response(stream, {
			status: 200,
			headers,
		});
	} catch (error) {
		console.error(
			"LABZ AI error:",
			error,
		);

		return jsonResponse(
			{
				error:
					"Sorry, LABZ AI couldn't process that message right now.",
			},
			500,
			origin,
		);
	}
}

/**
 * Cloudflare ES Module Worker entry point.
 */
export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const origin =
			request.headers.get("Origin");

		// CORS preflight
		if (request.method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: corsHeaders(origin),
			});
		}

		const url = new URL(request.url);

		// LABZ AI chat API
		if (
			url.pathname === "/api/chat" &&
			request.method === "POST"
		) {
			return handleChatRequest(
				request,
				env,
				origin,
			);
		}

		// Health check
		if (
			url.pathname === "/api/health" &&
			request.method === "GET"
		) {
			return jsonResponse(
				{
					ok: true,
					service: "LABZ AI",
				},
				200,
				origin,
			);
		}

		// Everything else is served from public/
		return env.ASSETS.fetch(request);
	},
};
```
