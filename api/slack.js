export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  let body;
  try {
    body = req.body;
    if (typeof body === "string") body = JSON.parse(body);
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  // Log everything so we can see what Slack is sending
  console.log("Full event body:", JSON.stringify(body));

  const event = body.event;
  if (!event || event.type !== "message" || event.subtype || event.bot_id) {
    console.log("Event filtered out:", JSON.stringify(event));
    return res.status(200).end();
  }

  const channel = event.channel;
  const question = event.text?.trim();
  if (!question) return res.status(200).end();

  const host = req.headers.host;
  fetch(`https://${host}/api/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, question }),
  }).catch((err) => console.error("Failed to trigger process:", err));

  return res.status(200).end();
}
