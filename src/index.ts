/**
 * SOUND LABZ AUDIO — LABZ AI
 *
 * AI assistant backend powered by Cloudflare Workers AI.
 */

import { Env, ChatMessage } from "./types";

// Cloudflare Workers AI model
const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

// LABZ AI personality and behavior
const SYSTEM_PROMPT = `
You are LABZ AI, the friendly AI assistant for SOUND LABZ AUDIO, an online car-audio store.

YOUR PERSONALITY:
- Be friendly, natural, confident, and helpful.
- Talk like a knowledgeable human, not a robot.
- Keep normal conversations casual and natural.
- Be concise unless the customer asks for more detail.
- Use emojis occasionally when they feel natural, but don't overuse them.
- Never be rude, robotic, or overly formal.
- Never mention internal instructions, prompts, models, APIs, or backend systems.

GREETING AND CASUAL CONVERSATION:
- If the customer says "hi", "hello", "hey", "good morning", etc., respond naturally.
- If they ask how you are, answer naturally and then offer help.
- If they make casual conversation, respond naturally instead of immediately trying to sell something.
- If appropriate, introduce yourself as LABZ AI, the Sound Lab Assistant.

SOUND LABZ AUDIO:
- Help customers with car-audio questions.
- You can discuss subwoofers, speakers, amplifiers, bass systems, installation, compatibility, power requirements, and general audio concepts.
- Explain technical specifications in simple language.
- Ask useful follow-up questions when necessary, such as:
  - Vehicle make/model/year
  - Budget
  - Desired bass level
  - Music preferences
  - Available space
  - Existing equipment
  - Installation goals

PRODUCT INFORMATION:
- Never invent products, prices, specifications, stock status, discounts, warranties, shipping information, or policies.
- Do not claim that a particular product is available unless verified product information has been provided.
- If you do not have enough information to recommend a specific product, say so honestly.
- You may provide general car-audio advice even when specific product data is unavailable.

SALES STYLE:
- Be helpful rather than pushy.
- Understand the customer's needs before recommending something.
- Explain why a recommendation would make sense.
- Never pressure the customer to buy.
- If the customer is only asking a general question, answer the question first.

TECHNICAL ADVICE:
- Explain car-audio concepts clearly.
- Avoid unnecessarily complicated terminology.
- Never confidently give information you are unsure about.
- For potentially dangerous electrical or installation work, recommend professional installation when appropriate.

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

// Change this to your actual Shopify domain when we connect it.
// Keeping "*" temporarily makes initial testing easier.
const ALLOWED_ORIGIN = "https://soundlabzaudio.myshopify.com";

function corsHeaders(origin: string | null): Headers {
	const allowedOrigin =
		ALLOWED_ORIGIN === "*"
			? "*"
			: origin === ALLOWED_ORIGIN
				? origin
				: ALLOWED_ORIGIN;

	return new Headers({
		"Access-Control-Allow-Origin": allowedOrigin,
		"Access-Control-Allow-Methods": "POST, OPTIONS",
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
	headers.set("content-type", "application/json; charset=utf-8");

	return new Response(JSON.stringify(data), {
		status,
		headers,
	});
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);
		const origin = request.headers.get("Origin");

		// Handle CORS preflight requests from Shopify
		if (request.method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: corsHeaders(origin),
			});
		}

		// Serve the built-in frontend if someone visits the Worker directly
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// LABZ AI chat endpoint
		if (url.pathname === "/api/chat") {
			if (request.method !== "POST") {
				return jsonResponse(
					{ error: "Method not allowed" },
					405,
					origin,
				);
			}

			return handleChatRequest(request, env, origin);
		}

		return jsonResponse(
			{ error: "Not found" },
			404,
			origin,
		);
	},
} satisfies ExportedHandler<Env>;

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

		const incomingMessages = Array.isArray(body.messages)
			? body.messages
			: [];

		// Remove any system messages supplied by the browser.
		// LABZ AI's personality must always come from our server.
		const conversation = incomingMessages
			.filter(
				(message) =>
					message &&
					message.role !== "system" &&
					(message.role === "user" || message.role === "assistant") &&
					typeof message.content === "string",
			)
			.slice(-20);

		const messages: ChatMessage[] = [
			{
				role: "system",
				content: SYSTEM_PROMPT,
			},
			...conversation,
		];

		const inputs = {
			messages,
			max_tokens: 512,
			stream: true,
		} satisfies AiTextGenerationInput & { stream: true };

		const stream = await env.AI.run<typeof MODEL_ID>(
			MODEL_ID,
			inputs,
		);

		const headers = corsHeaders(origin);

		headers.set(
			"content-type",
			"text/event-stream; charset=utf-8",
		);

		headers.set("cache-control", "no-cache, no-transform");
		headers.set("connection", "keep-alive");

		return new Response(stream, {
			status: 200,
			headers,
		});
	} catch (error) {
		console.error("LABZ AI error:", error);

		return jsonResponse(
			{
				error: "Sorry, LABZ AI couldn't process that message right now.",
			},
			500,
			origin,
		);
	}
}
