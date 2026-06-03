export const config = {
  runtime: "edge",
};

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const NOTION_INTRANET_URL = "https://www.notion.so/29bf862e950a80619162c55ed4096b87";

const SYSTEM_PROMPT = `You are AskPeople, a friendly HR assistant for Mesh. You help employees get quick answers to HR questions by searching the Mesh Company Intranet in Notion.

Your behavior:
1. When asked an HR question, search the Mesh Company Intranet Notion wiki using the notion-search tool with page_url: "${NOTION_INTRANET_URL}".
2. If you find relevant content, fetch the specific page(s) using notion-fetch to get full details, then give a clear and helpful answer. Mention which Notion page the info came from.
3. If you cannot find a confident answer from Notion, respond with EXACTLY this JSON and nothing else:
{"action":"create_ticket","summary":"<one sentence describing the question>","description":"<the employee's full question>"}
4. Keep answers concise, warm, and in plain language.
5. If the question is clearly not HR-related, politely say so.`;

async function postToSlack(channel, text) {
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, text }),
  });
  const data = await resp.json();
  console.log("Slack post result:", JSON.stringify(data));
  return data;
}

async function askClaude(question) {
  console.log("Calling Claude with question:", question);
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
"anthropic-beta": "mcp-client-2025-11-20",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: question }],
      mcp_servers: [
        { type: "url", url: "https://mcp.notion.com/mcp", name: "notion" },
        { type: "url", url: "https://mcp.atlassian.com/v1/mcp", name: "atlassian" },
      ],
    }),
  });
  const data = await resp.json();
console.log("Claude full response:", JSON.stringify(data));
  return data.content?.filter((b) => b.type === "text").map((b) => b.text).join("") || "";
}

async function createJiraTicket(summary, description) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
"anthropic-beta": "mcp-client-2025-11-20",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      system: `You are a Jira ticket creator. Use the createJiraIssue tool with cloudId: "meshconnectapi.atlassian.net", projectKey: "HR", issueTypeName: "HR inquiry". After creating, return only this JSON: {"ticketKey":"<key>","ticketUrl":"<url>"}`,
      messages: [{ role: "user", content: `Create an HR inquiry ticket. Summary: "${summary}". Description: "${description}"` }],
      mcp_servers: [
        { type: "url", url: "https://mcp.atlassian.com/v1/mcp", name: "atlassian" },
      ],
    }),
  });
  const data = await resp.json();
  const text = data.content?.map((b) => b.text || "").join("") || "";
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch {}
  return null;
}

export default async function handler(req) {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const body = await req.json();

  if (body.type === "url_verification") {
    return new Response(JSON.stringify({ challenge: body.challenge }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const event = body.event;
  if (!event || event.type !== "message" || event.subtype || event.bot_id) {
    return new Response("OK", { status: 200 });
  }

  const channel = event.channel;
  const question = event.text?.trim();
  if (!question) return new Response("OK", { status: 200 });

  // Use waitUntil to keep the edge function alive while processing
  const ctx = { waitUntil: (p) => p };
  
  const process = async () => {
    try {
      await postToSlack(channel, "Looking that up for you... 🔍");
      const answer = await askClaude(question);

      const jsonMatch = answer.match(/\{"action"\s*:\s*"create_ticket"[\s\S]*?\}/);
      if (jsonMatch) {
        let parsed;
        try { parsed = JSON.parse(jsonMatch[0]); } catch {}
        if (parsed?.action === "create_ticket") {
          await postToSlack(channel, "I couldn't find that in our HR knowledge base — raising a ticket with the HR team now...");
          const ticket = await createJiraTicket(parsed.summary || question, parsed.description || question);
          if (ticket?.ticketKey) {
            await postToSlack(channel, `✅ Ticket raised: *${ticket.ticketKey}* — ${parsed.summary || question}\nThe HR team will follow up with you shortly. ${ticket.ticketUrl ? `<${ticket.ticketUrl}|View ticket>` : ""}`);
          } else {
            await postToSlack(channel, "I tried to raise a ticket but hit an issue. Please reach out directly in *#ask-people*.");
          }
          return;
        }
      }

      await postToSlack(channel, answer);
    } catch (err) {
      console.error("AskPeople error:", err);
      await postToSlack(channel, "Something went wrong on my end. Please try again or reach out in *#ask-people*.");
    }
  };

  // waitUntil keeps the edge function alive after returning the response
  if (typeof EdgeRuntime !== "undefined") {
    // @ts-ignore
    globalThis.EdgeRuntime?.waitUntil?.(process());
  }

  // Also await it directly — edge runtime supports long-running responses
  await process();

  return new Response("OK", { status: 200 });
}
