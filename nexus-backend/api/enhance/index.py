# api/enhance/index.py
# LANGUAGE: Python 3.9 | PURPOSE: AI response quality improvement
# BUG FIX #5: This runs as its own Vercel function.
# send.js now imports enhance() logic inline instead of HTTP calling this.
# This file stays for direct API access if needed (e.g. admin tools).

from http.server import BaseHTTPRequestHandler
import json, re, sys


def split_sentences(text):
    return [p.strip() for p in re.split(r'(?<=[.!?])\s+', text.strip()) if p.strip()]


def remove_repetition(text, threshold=0.8):
    sentences = split_sentences(text)
    if len(sentences) <= 1:
        return text
    kept, seen = [], []
    for s in sentences:
        words = set(re.findall(r'\w+', s.lower()))
        if not words:
            kept.append(s); continue
        dup = any(
            len(words & sw) / len(words | sw) >= threshold
            for sw in seen if (words | sw)
        )
        if not dup:
            kept.append(s)
            seen.append(words)
    return ' '.join(kept)


def clean_artifacts(text):
    text = re.sub(r'\n{3,}', '\n\n', text)
    return '\n'.join(l.rstrip() for l in text.split('\n')).strip()


def score_quality(text):
    if not text or len(text) < 10:
        return 0.1
    score = 0.5
    if len(text) > 100: score += 0.1
    if len(text) > 300: score += 0.1
    if len(text) > 600: score += 0.05
    if len(split_sentences(text)) >= 2: score += 0.1
    if re.search(r'^#{1,3}\s', text, re.MULTILINE): score += 0.05
    if re.search(r'^[\-\*]\s', text, re.MULTILINE): score += 0.05
    if re.search(r'`', text): score += 0.05
    words = re.findall(r'\w+', text.lower())
    if words and len(set(words)) / len(words) < 0.4:
        score -= 0.2
    return min(max(round(score, 2), 0.0), 1.0)


def detect_truncation(text):
    stripped = text.rstrip()
    if not stripped: return True
    if stripped[-1] not in '.!?…`\'")}]':
        if re.search(r'\w+$', stripped): return True
    return False


def enhance(text):
    if not text or not text.strip():
        return {"enhanced": text, "quality": 0.0, "truncated": True, "changes": []}
    changes = []
    cleaned = clean_artifacts(text)
    if cleaned != text: changes.append("cleaned_artifacts"); text = cleaned
    deduped = remove_repetition(text)
    if deduped != text: changes.append("removed_repetition"); text = deduped
    return {
        "enhanced":  text,
        "quality":   score_quality(text),
        "truncated": detect_truncation(text),
        "changes":   changes,
    }


class handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,Authorization")
        self.end_headers()

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length))
            result = enhance(data.get("text", ""))
            self._ok(result)
        except Exception as e:
            self._ok({"enhanced": "", "quality": 0.5, "truncated": False, "changes": [], "error": str(e)})

    def do_GET(self):
        self._ok({"status": "ok", "python": sys.version})

    def _ok(self, body):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())
