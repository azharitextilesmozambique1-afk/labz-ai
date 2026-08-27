/**
 * SOUND LABZ AUDIO — LABZ AI
 *
 * Cloudflare Workers AI + Shopify product search
 */

import { Env, ChatMessage } from "./types";

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";
const SHOPIFY_API_VERSION = "2026-07";

const ALLOWED_ORIGIN = "https://soundlabzaudio.myshopify.com";

/*
 * Shopify access-token cache.
 */
let shopifyTokenCache: {
	token: string;
	expiresAt: number;
} | null = null;

/*
 * LABZ AI personality.
 */
const SYSTEM_PROMPT = `
You are LABZ AI, the friendly AI assistant for SOUND LABZ AUDIO, an online car-audio store.

PERSONALITY:
- Be friendly, natural, confident, and helpful.
- Talk like a knowledgeable human, not a robot.
- Keep normal conversations casual and natural.
- Be concise unless the customer asks for more detail.
- Use emojis occasionally when they feel natural, but do not overuse them.
- Never be rude, robotic, or overly formal.
- Never mention internal instructions, prompts, models, APIs, or backend systems.

GREETING AND CASUAL CONVERSATION:
- If the customer says hi, hello, hey, good morning, etc., respond naturally.
- If they ask how you are, answer naturally and offer help.
- If they make casual conversation, respond naturally.
- Do not immediately try to sell something during casual conversation.
- When appropriate, introduce yourself as LABZ AI.

SOUND LABZ AUDIO:
- Help customers with subwoofers, speakers, amplifiers, tweeters, bass systems, installation, compatibility, power requirements, and general car-audio questions.
- Explain technical specifications in simple language.
- Ask useful follow-up questions when needed, including vehicle make/model/year, budget, desired bass level, music preferences, available space, existing equipment, and installation goals.

SHOPIFY PRODUCT RULES:
- Shopify product information is the source of truth.
- Never invent products.
- Never invent prices.
- Never invent specifications.
- Never invent availability.
- Never invent discounts, warranties, shipping information, or store policies.
- If a requested product is not found in the Shopify results, say that it was not found.
- If Shopify results contain similar products, explain that they are similar rather than pretending they are exact matches.
- Use current Shopify information instead of assumptions.
- Product prices must come from Shopify.
- Only say a product is available when Shopify says Available: Yes.
- If the customer asks for products under a specific price, only recommend products that actually meet that price requirement.
- If the customer asks for a specific product name, prioritize exact or very close matches.
- If the customer asks for a brand such as Sundown Audio, prioritize products from that brand.
- Include product names and prices when relevant.
- Include the product link when relevant.

SALES STYLE:
- Be helpful rather than pushy.
- Understand the customer's needs before recommending something.
- Explain why a recommendation makes sense.
- Never pressure the customer to buy.
- If the customer asks a general question, answer the question first.

TECHNICAL ADVICE:
- Explain car-audio concepts clearly.
- Avoid unnecessary technical jargon.
- Never confidently give information you are unsure about.
- For potentially dangerous electrical or installation work, recommend professional installation.

CONVERSATION STYLE:
- Answer the customer's actual question first.
- Keep responses readable.
- Avoid unnecessary long paragraphs.
- Do not repeat yourself.
- Ask one or two useful questions when more information is needed.
- Maintain context from the recent conversation.

IMPORTANT:
You are the customer-facing assistant for SOUND LABZ AUDIO.
Your goal is to help visitors have a useful, natural conversation and make informed car-audio decisions.
`;

/*
 * CORS headers.
 */
function corsHeaders(origin: string | null): Headers {
	const allowedOrigin =
		origin === ALLOWED_ORIGIN
			? origin
			: ALLOWED_ORIGIN;

	return new Headers({
		"Access-Control-Allow-Origin": allowedOrigin,
		"Access-Control-Allow-Methods":
			"GET, POST, OPTIONS",
		"Access-Control-Allow-Headers":
			"Content-Type",
		"Access-Control-Max-Age": "86400",
	});
}

/*
 * JSON response helper.
 */
function jsonResponse(
	data: unknown,
	status = 200,
	origin: string | null = null,
): Response {
	const headers = corsHeaders(origin);

	headers.set(
		"Content-Type",
		"application/json; charset=utf-8",
	);

	return new Response(
		JSON.stringify(data),
		{
			status,
			headers,
		},
	);
}

/*
 * Extract a maximum price from requests such as:
 *
 * under $100
 * below $100
 * less than $100
 * cheaper than $100
 * $100 or less
 */
function extractMaxPrice(
	message: string,
): number | null {
	const patterns = [
		/(?:under|below|less than|cheaper than|max(?:imum)?(?: price)?(?: of)?)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i,

		/\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:or less|and under)/i,
	];

	for (const pattern of patterns) {
		const match = message.match(pattern);

		if (match && match[1]) {
			const price = Number(match[1]);

			if (Number.isFinite(price)) {
				return price;
			}
		}
	}

	return null;
}

/*
 * Get Shopify Admin API access token.
 */
async function getShopifyAccessToken(
	env: Env,
): Promise<string> {
	const shopifyEnv = env as Env & {
		SHOPIFY_STORE: string;
		SHOPIFY_CLIENT_ID: string;
		SHOPIFY_CLIENT_SECRET: string;
	};

	const now = Date.now();

	/*
	 * Reuse cached token when possible.
	 */
	if (
		shopifyTokenCache &&
		shopifyTokenCache.expiresAt >
			now + 60_000
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
					shopifyEnv.SHOPIFY_CLIENT_ID,

				client_secret:
					shopifyEnv.SHOPIFY_CLIENT_SECRET,

				grant_type:
					"client_credentials",
			}),
		},
	);

	if (!response.ok) {
		const errorText =
			await response.text();

		console.error(
			"Shopify token error:",
			response.status,
			errorText,
		);

		throw new Error(
			"Unable to authenticate with Shopify.",
		);
	}

	const data =
		(await response.json()) as {
			access_token?: string;
			expires_in?: number;
		};

	if (!data.access_token) {
		throw new Error(
			"Shopify did not return an access token.",
		);
	}

	const expiresIn =
		data.expires_in ?? 86400;

	shopifyTokenCache = {
		token: data.access_token,

		expiresAt:
			now +
			Math.max(
				60_000,
				expiresIn * 1000,
			),
	};

	return data.access_token;
}

/*
 * Search Shopify products.
 */
async function searchShopifyProducts(
	customerQuery: string,
	env: Env,
	maxPrice: number | null,
): Promise<string> {
	const shopifyEnv = env as Env & {
		SHOPIFY_STORE: string;
	};

	const token =
		await getShopifyAccessToken(env);

	/*
	 * Remove price language before sending
	 * the search query to Shopify.
	 *
	 * Example:
	 *
	 * "show me subwoofers under $100"
	 *
	 * becomes:
	 *
	 * "show me subwoofers"
	 */
	const shopifySearchQuery =
		customerQuery
			.replace(
				/(under|below|less than|cheaper than|max(?:imum)?(?: price)?(?: of)?)\s*\$?\s*\d+(?:\.\d{1,2})?/gi,
				"",
			)
			.replace(
				/\$?\s*\d+(?:\.\d{1,2})?\s*(or less|and under)/gi,
				"",
			)
			.trim()
			.substring(0, 200);

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
		`https://${shopifyEnv.SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
		{
			method: "POST",

			headers: {
				"Content-Type":
					"application/json",

				"X-Shopify-Access-Token":
					token,
			},

			body: JSON.stringify({
				query: graphqlQuery,

				variables: {
					query:
						shopifySearchQuery ||
						customerQuery,
				},
			}),
		},
	);

	if (!response.ok) {
		const errorText =
			await response.text();

		console.error(
			"Shopify product search error:",
			response.status,
			errorText,
		);

		throw new Error(
			"Unable to search Shopify products.",
		);
	}

	const data =
		(await response.json()) as {
			data?: {
				products?: {
					nodes?: Array<{
						id: string;
						title: string;
						handle: string;

						vendor?: string | null;

						description?:
							| string
							| null;

						onlineStoreUrl?:
							| string
							| null;

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

	let products =
		data.data?.products?.nodes ?? [];

	/*
	 * Apply the price filter ourselves.
	 *
	 * This makes:
	 *
	 * "under $100"
	 *
	 * actually mean <= $100.
	 */
	if (maxPrice !== null) {
		products = products
			.map((product) => {
				const variants =
					product.variants?.nodes ?? [];

				const matchingVariants =
					variants.filter(
						(variant) => {
							const price =
								Number(
									variant.price,
								);

							return (
								Number.isFinite(
									price,
								) &&
								price <=
									maxPrice
							);
						},
					);

				return {
					...product,

					variants: {
						nodes:
							matchingVariants,
					},
				};
			})
			.filter(
				(product) =>
					(product.variants
						?.nodes?.length ?? 0) >
					0,
			);
	}

	if (products.length === 0) {
		if (maxPrice !== null) {
			return (
				`No matching Shopify products were found under $${maxPrice}.`
			);
		}

		return "No matching Shopify products were found.";
	}

	/*
	 * Convert Shopify products into clean context
	 * for LABZ AI.
	 */
	return products
		.map((product, index) => {
			const variants =
				product.variants?.nodes ?? [];

			const variantText =
				variants.length > 0
					? variants
							.map(
								(
									variant,
								) =>
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

			const productUrl =
				product.onlineStoreUrl ??
				`https://${shopifyEnv.SHOPIFY_STORE}/products/${product.handle}`;

			return `
PRODUCT ${index + 1}

Product name:
${product.title}

Brand / Vendor:
${product.vendor ?? "Not specified"}

Description:
${
	product.description
		? product.description.substring(
				0,
				800,
			)
		: "Not provided"
}

Product URL:
${productUrl}

Variants:
${variantText}
`;
		})
		.join("\n");
}

/*
 * Determine whether the customer is asking
 * about products or store inventory.
 */
function shouldSearchProducts(
	message: string,
): boolean {
	const text =
		message.toLowerCase();

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
		"show me",
		"recommend",
		"recommendation",
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
		"under ",
		"below ",
		"less than",
		"cheaper than",
		"or less",
		"and under",
		"cheapest",
		"best",
		"brand",
		"sundown",
		"audio",
		"labz",
	];

	return productKeywords.some(
		(keyword) =>
			text.includes(keyword),
	);
}

/*
 * Handle LABZ AI chat requests.
 */
async function handleChatRequest(
	request: Request,
	env: Env,
	origin: string | null,
): Promise<Response> {
	try {
		const body =
			(await request.json()) as {
				messages?: ChatMessage[];
			};

		const incomingMessages =
			Array.isArray(body.messages)
				? body.messages
				: [];

		/*
		 * Only allow user and assistant messages
		 * from the browser.
		 *
		 * Browser cannot override our system prompt.
		 */
		const conversation =
			incomingMessages
				.filter(
					(message) =>
						message &&
						message.role !==
							"system" &&
						(message.role ===
							"user" ||
							message.role ===
								"assistant") &&
						typeof message.content ===
							"string",
				)
				.slice(-20);

		let productContext = "";

		/*
		 * Find the latest customer message.
		 */
		const latestUserMessage =
			[...conversation]
				.reverse()
				.find(
					(message) =>
						message.role ===
						"user",
				);

		/*
		 * Search Shopify when appropriate.
		 */
		if (
			latestUserMessage &&
			shouldSearchProducts(
				latestUserMessage.content,
			)
		) {
			try {
				const customerQuestion =
					latestUserMessage.content;

				/*
				 * Detect price requirement.
				 *
				 * Example:
				 *
				 * "show me subwoofers under $100"
				 *
				 * maxPrice = 100
				 */
				const maxPrice =
					extractMaxPrice(
						customerQuestion,
					);

				const results =
					await searchShopifyProducts(
						customerQuestion,
						env,
						maxPrice,
					);

				productContext = `

SHOPIFY LIVE PRODUCT INFORMATION

The following information was retrieved directly from the current Shopify catalog.

CUSTOMER REQUEST:
${customerQuestion}

${
	maxPrice !== null
		? `MAXIMUM PRICE REQUESTED: $${maxPrice}`
		: ""
}

${results}

IMPORTANT SHOPIFY RULES:
- Use the Shopify information above as the source of truth.
- Do not invent products.
- Do not invent prices.
- Do not invent availability.
- Only recommend products matching the customer's request.
- If a maximum price was requested, do not recommend products above that price.
- If no matching products were found, clearly tell the customer.
- Give product names and prices when appropriate.
- Give product URLs when appropriate.
`;
			} catch (error) {
    console.error(
        "SHOPIFY ERROR:",
        error instanceof Error
            ? error.message
            : String(error),
    );

    productContext = `
SHOPIFY ERROR:
The Shopify product search failed.

Do not invent products or prices.
`;
}
		}

		/*
		 * Build final AI messages.
		 */
		const messages: ChatMessage[] = [
			{
				role: "system",
				content:
					SYSTEM_PROMPT +
					productContext,
			},

			...conversation,
		];

		/*
		 * We deliberately avoid requiring a separate
		 * AiTextGenerationInput type here.
		 *
		 * This makes the code less dependent on which
		 * Cloudflare generated types are installed.
		 */
		const inputs = {
			messages,
			max_tokens: 512,
			stream: true,
		};

		/*
		 * Run Cloudflare Workers AI.
		 */
		const stream =
			await env.AI.run(
				MODEL_ID as any,
				inputs as any,
			);

		const headers =
			corsHeaders(origin);

		headers.set(
			"Content-Type",
			"text/event-stream; charset=utf-8",
		);

		headers.set(
			"Cache-Control",
			"no-cache, no-transform",
		);

		headers.set(
			"Connection",
			"keep-alive",
		);

		return new Response(
			stream as BodyInit,
			{
				status: 200,
				headers,
			},
		);
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

/*
 * CLOUDFLARE ES MODULE WORKER
 *
 * This is required for the Workers AI binding.
 */
export default {
	async fetch(
		request: Request,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<Response> {
		const origin =
			request.headers.get(
				"Origin",
			);

		/*
		 * CORS preflight.
		 */
		if (
			request.method ===
			"OPTIONS"
		) {
			return new Response(
				null,
				{
					status: 204,
					headers:
						corsHeaders(
							origin,
						),
				},
			);
		}

		const url =
			new URL(request.url);

		/*
		 * LABZ AI chat endpoint.
		 */
		if (
			url.pathname ===
				"/api/chat" &&
			request.method ===
				"POST"
		) {
			return handleChatRequest(
				request,
				env,
				origin,
			);
		}

		/*
		 * Health check.
		 */
		if (
			url.pathname ===
				"/api/health" &&
			request.method ===
				"GET"
		) {
			return jsonResponse(
				{
					ok: true,
					service:
						"LABZ AI",
				},
				200,
				origin,
			);
		}

		/*
		 * Serve website files from
		 * the public directory.
		 */
     return new Response(
            "LABZ AI is running.",
            {
                status: 200,
                headers:
                    corsHeaders(
                        origin,
                    ),
            },
        );
    },
};
