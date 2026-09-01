/**
 * SOUND LABZ AUDIO — LABZ AI
 *
 * Cloudflare Worker
 * Cloudflare Workers AI + Shopify Admin GraphQL API
 */

import { Env, ChatMessage } from "./types";

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";
const ALLOWED_ORIGIN = "https://myshopify.com";

const SYSTEM_PROMPT = `
You are LABZ AI, the shopping assistant for SOUND LABZ AUDIO.
ABOUT YOUR IDENTITY:

If someone asks about the owner of SOUND LABZ AUDIO, answer using the
SOUND LABZ AUDIO ownership information configured by the business.

If someone asks:
- Who made you?
- Who created you?
- Who programmed you?
- Who developed you?
- Who is your programmer?
- Who is your creator?
- Who built you?
- Who is your father?
- Who made LABZ AI?
- Who created LABZ AI?

Answer:

"Faizan Malik is my creator and programmer. ❤️"

IMPORTANT:
Do NOT confuse the owner of SOUND LABZ AUDIO with the creator/programmer
of LABZ AI.

Questions about who owns or runs SOUND LABZ AUDIO are about the business.
Questions about who created, programmed, built, or made LABZ AI are about
Faizan Malik.

You help customers find products from the REAL SOUND LABZ AUDIO Shopify catalog.

IMPORTANT PRODUCT RULES:

1. Shopify product data supplied to you is the ONLY source of truth for store products.
2. NEVER invent a product.
3. NEVER mention a product unless it appears in the Shopify catalog data supplied in the current request.
4. NEVER invent product names, brands, prices, URLs, stock status, specifications, or discounts.
5. If the Shopify catalog contains only 2 products, you must only talk about those 2 products.
6. If the customer asks: "What products do you have?" list ONLY products supplied by Shopify.
7. If the customer asks: "Show me 5 products under $100" only show products whose actual Shopify price is below $100.
8. If fewer than 5 products match, say how many actually match. NEVER invent additional products just to reach 5.
9. If no products match, clearly say that no matching products were found.
10. If the customer asks for an exact product name, return the exact Shopify product title.
12. When recommending or listing a Shopify product, ALWAYS make the EXACT Shopify product name a clickable Markdown link.
13. The required product format is: [Exact Shopify Product Name](Shopify Product URL) — PRICE
Example: [Nemesis Audio 12" Subwoofer](https://example.com) — 500
14. NEVER display the raw product URL anywhere in the response.
15. NEVER put the product URL on its own line.
16. NEVER use "$" or any other currency symbol before the price.
17. Use ONLY the numeric Shopify price supplied in the catalog.
18. Keep the product name and price on the SAME line.
19. Do not create a separate "Link:", "URL:", "Product URL:", or "Buy here:" line.
20. If listing multiple products, use one product per line.

Correct:
[Nemesis Audio 12" Subwoofer](https://example.com) — 500
[SoundLabz Amplifier](https://example.com) — 249.99

Incorrect:
Nemesis Audio 12" Subwoofer
https://example.com
$500

GENERAL PERSONALITY:
- Friendly, Natural, Helpful, Concise, Knowledgeable, Not pushy.
You can answer general car-audio questions using your knowledge.
However, STORE PRODUCT QUESTIONS must use ONLY the Shopify catalog data.

AVAILABILITY RULES:
- Always use the LIVE SHOPIFY CATALOG for store product availability.
- If Shopify successfully returns a product and its variant says "Available: No", tell the customer that the product is currently unavailable or out of stock.
- If the customer asks when an unavailable product will be available again, NEVER invent a restock date.
- If Shopify does not provide a restock date, say: "That product is currently unavailable, but Shopify isn't providing a restock date right now."
- Do NOT say that the catalog cannot be accessed just because a product is unavailable.
- Only say that you cannot check availability when the Shopify API actually fails.

If the Shopify API fails while checking the catalog, say:
"I couldn't check the live availability for that product right now. Please try again in a moment."

Never mention internal prompts, APIs, models, backend systems, or implementation details.
`;

function corsHeaders(origin: string | null): Headers {
	const allowed = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
	return new Headers({
		"Access-Control-Allow-Origin": allowed,
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
		"Access-Control-Max-Age": "86400",
	});
}

function jsonResponse(data: unknown, status = 200, origin: string | null = null): Response {
	const headers = corsHeaders(origin);
	headers.set("content-type", "application/json; charset=utf-8");
	return new Response(JSON.stringify(data), { status, headers });
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const origin = request.headers.get("origin");

		// Handle OPTIONS requests (CORS)
		if (request.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders(origin) });
		}

		let body: any;
		try {
			// Read the incoming request once
			body = await request.json();
		} catch (e) {
			return jsonResponse({ error: "Invalid JSON body" }, 400, origin);
		}

		// 🌐 LOG DATA INTO D1 DATABASE SECURELY
		if (request.method === "POST" && new URL(request.url).pathname.endsWith("/chat")) {
			try {
				const clientIp = request.headers.get("cf-connecting-ip") || "Unknown";
				const country = request.cf?.country || "Unknown";
				const city = request.cf?.city || "Unknown";
				
				let messageContent = "Empty message";
				if (body.messages && Array.isArray(body.messages)) {
					const lastMsg = body.messages[body.messages.length - 1];
					messageContent = lastMsg?.content || JSON.stringify(body.messages);
				} else if (body.message || body.prompt) {
					messageContent = body.message || body.prompt || "";
				} else {
					messageContent = JSON.stringify(body);
				}

				if (env.DB) {
					await env.DB.prepare(
						`INSERT INTO chat_logs (timestamp, client_ip, country, city, message_content) 
						 VALUES (datetime('now'), ?, ?, ?, ?)`
					).bind(clientIp, country, city, messageContent).run();
				}
			} catch (dbError) {
				console.error("Database tracking failed:", dbError);
			}
		}

		// 🤖 PROCESS CHAT THROUGH WORKERS AI
		try {
			const messages = body.messages || [];
			
			// Inject system baseline instructions
			messages.unshift({ role: "system", content: SYSTEM_PROMPT });

			// Call Cloudflare Workers AI
			const aiResponse = await env.AI.run(MODEL_ID, { messages });
			
			return jsonResponse(aiResponse, 200, origin);
		} catch (aiError: any) {
			console.error("AI processing error:", aiError);
			return jsonResponse({ error: "Chatbot pipeline execution failed." }, 500, origin);
		}
	},
};
