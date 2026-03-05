export function formatTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}
export function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const diff = Math.floor((Date.now() - d) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7)  return `${diff}d ago`;
  return d.toLocaleDateString("en-US", { month:"short", day:"numeric" });
}
export function truncate(str, n) {
  return !str ? "" : str.length <= n ? str : str.slice(0, n) + "…";
}
export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
export function generateConvTitle(msg) {
  return truncate(msg, 42) || "New conversation";
}
export function apiBase() {
  return process.env.NEXT_PUBLIC_API_URL || "";
}
