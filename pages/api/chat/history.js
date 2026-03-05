import { authFromHeader } from "../../../lib/auth";
import { getUserConversations, getConversation } from "../../../lib/github-db";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")     return res.status(405).json({ error: "Method not allowed" });

  const user = authFromHeader(req.headers["authorization"]);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { id } = req.query;
  if (id) {
    const conv = await getConversation(user.username, id);
    if (!conv) return res.status(404).json({ error: "Not found" });
    return res.status(200).json({ conversation: conv });
  }

  const { conversations } = await getUserConversations(user.username);
  return res.status(200).json({
    conversations: conversations.map(c => ({
      id: c.id, title: c.title, updatedAt: c.updatedAt,
      createdAt: c.createdAt, model: c.model,
      messageCount: c.messages?.length || 0,
      preview: c.messages?.slice(-1)[0]?.content?.slice(0,80) || "",
    })),
  });
}
