export default function handler(req, res) {
  res.status(200).json({ status: "nexus-backend online", ts: new Date().toISOString() });
}
