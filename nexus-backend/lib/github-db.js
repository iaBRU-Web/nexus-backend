/**
 * lib/github-db.js  — YOUR permanent database inside your private GitHub repo
 *
 * BUG FIX #2: env vars now read inside functions, not at module load time
 *             (module-level constants were undefined when imported)
 * BUG FIX #6: GitHub API returns base64 with \n chars — now stripped before decode
 */

// Read env vars fresh on every call — prevents undefined-at-import bug
function ghHeaders() {
  return {
    "Authorization": `token ${process.env.GITHUB_DB_TOKEN}`,
    "Accept":        "application/vnd.github.v3+json",
    "Content-Type":  "application/json",
    "User-Agent":    "nexus-ai-backend",
  };
}
function ghBase() {
  return `https://api.github.com/repos/${process.env.GITHUB_DB_REPO}/contents`;
}

// ── Low-level read / write ─────────────────────────────────────────────────────

export async function dbRead(filePath) {
  try {
    const res = await fetch(`${ghBase()}/${filePath}`, {
      headers: ghHeaders(),
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub read failed: ${res.status}`);
    const json = await res.json();
    // BUG FIX #6: strip newlines GitHub inserts into base64 content
    const cleaned = json.content.replace(/\n/g, "");
    const content = Buffer.from(cleaned, "base64").toString("utf8");
    return { data: JSON.parse(content), sha: json.sha };
  } catch (err) {
    console.error(`[db] read(${filePath}):`, err.message);
    return null;
  }
}

export async function dbWrite(filePath, data, sha = null) {
  try {
    const content = Buffer.from(JSON.stringify(data, null, 2)).toString("base64");
    const body = {
      message: `nexus: update ${filePath}`,
      content,
      ...(sha ? { sha } : {}),
    };
    const res = await fetch(`${ghBase()}/${filePath}`, {
      method:  "PUT",
      headers: ghHeaders(),
      body:    JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || `GitHub write failed: ${res.status}`);
    }
    const result = await res.json();
    return result.content?.sha || null;
  } catch (err) {
    console.error(`[db] write(${filePath}):`, err.message);
    throw err;
  }
}

// ── Users ─────────────────────────────────────────────────────────────────────

export async function getUsers() {
  const result = await dbRead("users.json");
  return result ? { users: result.data, sha: result.sha } : { users: {}, sha: null };
}

export async function getUser(username) {
  const { users } = await getUsers();
  return users[username.toLowerCase()] || null;
}

export async function createUser(username, passwordHash) {
  const { users, sha } = await getUsers();
  const key = username.toLowerCase();
  if (users[key]) return false;
  users[key] = {
    username:     key,
    displayName:  username,
    passwordHash,
    createdAt:    new Date().toISOString(),
  };
  await dbWrite("users.json", users, sha);
  return true;
}

// ── Conversations ─────────────────────────────────────────────────────────────

const chatPath = u => `chats/${u.toLowerCase()}.json`;

export async function getUserConversations(username) {
  const result = await dbRead(chatPath(username));
  return result
    ? { conversations: result.data.conversations || [], sha: result.sha }
    : { conversations: [], sha: null };
}

export async function getConversation(username, convId) {
  const { conversations } = await getUserConversations(username);
  return conversations.find(c => c.id === convId) || null;
}

export async function saveConversation(username, conversation) {
  const { conversations, sha } = await getUserConversations(username);
  const idx = conversations.findIndex(c => c.id === conversation.id);
  if (idx >= 0) conversations[idx] = conversation;
  else conversations.unshift(conversation);
  await dbWrite(chatPath(username), { conversations: conversations.slice(0, 60) }, sha);
}

export async function deleteConversation(username, convId) {
  const { conversations, sha } = await getUserConversations(username);
  await dbWrite(chatPath(username), { conversations: conversations.filter(c => c.id !== convId) }, sha);
}

export async function clearUserChats(username) {
  const { sha } = await getUserConversations(username);
  await dbWrite(chatPath(username), { conversations: [] }, sha);
}
