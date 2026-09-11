#!/usr/bin/env node
/**
 * PreToolUse(Bash) hook for read-only subagents (reviewer, guardian).
 * Blocks commands that change the repository, the remote, or the PR so an
 * independent reviewer can never become the writer or the merger.
 * Fails open on malformed input.
 */
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

const raw = await readStdin();
let command = "";
try {
  command = String(JSON.parse(raw)?.tool_input?.command ?? "");
} catch {
  process.exit(0);
}

const WRITE_PATTERNS = [
  /\bgit\s+(push|commit|merge|rebase|reset|revert|cherry-pick|tag|stash|apply|am|rm|mv|restore|clean)\b/,
  /\bgit\s+checkout\s+(-b|-B|--\s)/,
  /\bgit\s+switch\s+(-c|-C)\b/,
  /\bgh\s+pr\s+(merge|ready|edit|comment|close|reopen|create|review)\b/,
  /\bgh\s+(issue|release|repo|workflow|run\s+(rerun|cancel))\b/,
  /\bgh\s+api\b.*(-X|--method)\s*(POST|PUT|PATCH|DELETE)/i,
  /\bpnpm\s+(add|remove|install|update)\b/,
  /(^|[;&|]\s*)(rm|mv|cp|sed\s+-i|tee)\b/,
  /(^|[^<>])>{1,2}\s*[^&\s]/,
];

const hit = WRITE_PATTERNS.find((re) => re.test(command));
if (hit) {
  process.stderr.write(
    `Blocked by .claude/hooks/readonly-bash.mjs: reviewers are read-only (writer ≠ reviewer). Report the finding instead of running: ${command.slice(0, 200)}\n`,
  );
  process.exit(2);
}
process.exit(0);
