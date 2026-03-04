import { authFromHeader } from "../../lib/auth";
import { clearUserChats, deleteConversation } from "../../lib/github-db";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "DELETE")  return res.status(405).json({ error: "Method not allowed" });

  const user = authFromHeader(req.headers["authorization"]);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { id } = req.query;
  if (id) {
    await deleteConversation(user.username, id);
    return res.status(200).json({ deleted: id });
  }
  await clearUserChats(user.username);
  return res.status(200).json({ cleared: true });
}
