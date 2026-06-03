export const config = {
  runtime: "edge",
};

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_EMAIL = process.env.JIRA_EMAIL;

const JIRA_BASE_URL = "https://meshconnectapi.atlassian.net";
const JIRA_PROJECT = "HR";

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
  console.log("Slack post:", data.ok, data.error || "");
  return data;
}

async function searchNotion(query) {
  console.log("Searching Notion for:", query);
  const resp = await fetch("https://api.notion.com/v1/search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_TOKEN}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({
      query,
      filter: { value: "page", property: "object" },
      page_size: 10,
      sort: { direction: "descending", timestamp: "last_edited_time" },
    }),
  });
  const data = await resp.json();
  console.log("Notion results:", data.results?.length, "error:", data.message || "none");
  console.log("Page titles found:", data.results?.map(p =>
    p.properties?.title?.title?.[0]?.plain_text ||
    p.properties?.Name?.title?.[0]?.plain_text ||
    "Untitled"
  ).join(", "));
  return data.results || [];
}

async function getNotionBlocks(pageId) {
  const resp = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=50`, {
    headers: {
      "Authorization": `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
    },
  });
  const data = await resp.json();
  const blocks = data.results || [];
  console.log("Blocks for page", pageId, "count:", blocks.length, "types:", blocks.slice(0, 3).map(b => b.type).join(","));
  return blocks;
}

function extractText(blocks) {
  const lines = [];
  for (const block of blocks) {
    const type = block.type;
    const content = block[type];

    if (content?.rich_text?.length > 0) {
      const text = content.rich_text.map(t => t.plain_text).join("");
      if (text.trim()) lines.push(text);
    }

    if (type === "child_page") {
      lines.push(`[Page: ${block.child_page?.title || ""}]`);
    }

    if (type === "child_database") {
      lines.push(`[Database: ${block.child_database?.title || ""}]`);
    }
  }
  return lines.join("\n").slice(0, 3000);
}

async function askClaude(question, notionContext) {
  console.log("Calling Claude, context length:", notionContext.length);

  const systemPrompt = `You are AskPeople, a friendly HR assistant for Mesh. You help employees get quick answers to HR questions.

Here is content retrieved from the Mesh Company Intranet in Notion:

${notionContext}

Instructions:
1. Answer the employee's question based on the content above.
2. Be concise, warm, and use plain language.
3. If the content does not contain enough information to answer confidently, respond with EXACTLY this JSON and nothing else:
{"action":"create_ticket","summary":"<one sentence describing the question>","description":"<the employee's full question>"}
4. If the question is not HR-related, politely say so.`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: question }],
    }),
  });
  const data = await resp.json();
  console.log("Claude type:", data.type, "stop_reason:", data.stop_reason);
  const answer = data.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
  console.log("Claude answer preview:", answer.slice(0, 200));
  return answer;
}

async function createJiraTicket(summary, description) {
  console.log("Creating Jira ticket:", summary);
  const auth = btoa(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`);
  const resp = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        project: { key: JIRA_PROJECT },
        summary,
        description: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: description }] }],
        },
        issuetype: { name: "HR inquiry" },
      },
    }),
  });
  const data = await resp.json();
  console.log("Jira result:", data.key || JSON.stringify(data).slice(0, 200));
  if (data.key) {
    return { ticketKey: data.key, ticketUrl: `${JIRA_BASE_URL}/browse/${data.key}` };
  }
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

  // Ignore Slack retries — these cause duplicate messages
  const retryNum = req.headers.get("x-slack-retry-num");
  if (retryNum) {
    console.log("Slack retry, skipping:", retryNum);
    return new Response("OK", { status: 200 });
  }

  const process = async () => {
    try {
      await postToSlack(channel, "Looking that up for you... 🔍");

      const pages = await searchNotion(question);
      let notionContext = "";

      for (const page of pages.slice(0, 3)) {
        const title =
          page.properties?.title?.title?.[0]?.plain_text ||
          page.properties?.Name?.title?.[0]?.plain_text ||
          page.properties?.["Page"]?.title?.[0]?.plain_text ||
          "Untitled";
        const blocks = await getNotionBlocks(page.id);
        const text = extractText(blocks);
        console.log(`Page "${title}" extracted text length:`, text.length);
        if (text.trim()) {
          notionContext += `\n\n--- ${title} ---\n${text}`;
        }
      }

      if (!notionContext.trim()) {
        notionContext = "No relevant content found in the Mesh Company Intranet.";
      }

      console.log("Total context length:", notionContext.length);

      const answer = await askClaude(question, notionContext);

      const jsonMatch = answer.match(/\{"action"\s*:\s*"create_ticket"[\s\S]*?\}/);
      if (jsonMatch) {
        let parsed;
        try { parsed = JSON.parse(jsonMatch[0]); } catch {}
        if (parsed?.action === "create_ticket") {
          await postToSlack(channel, "I couldn't find that in our HR knowledge base — raising a ticket with the HR team now...");
          const ticket = await createJiraTicket(
            parsed.summary || question,
            `Submitted via AskPeople Slack bot\n\n${parsed.description || question}`
          );
          if (ticket?.ticketKey) {
            await postToSlack(channel, `✅ Ticket raised: *${ticket.ticketKey}* — ${parsed.summary || question}\nThe HR team will follow up with you shortly. <${ticket.ticketUrl}|View ticket>`);
          } else {
            await postToSlack(channel, "I tried to raise a ticket but hit an issue. Please reach out directly in *#ask-people*.");
          }
          return;
        }
      }

      await postToSlack(channel, answer);

    } catch (err) {
      console.error("AskPeople error:", err.message);
      await postToSlack(channel, "Something went wrong on my end. Please try again or reach out in *#ask-people*.");
    }
  };

 await process();

return new Response("OK", { status: 200 });
}
