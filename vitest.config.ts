import { defineConfig } from "vitest/config";

// SQLite is now Node's built-in `node:sqlite` (no native addon), so no externalization is needed —
// vitest treats `node:*` builtins as external automatically.
//
// setupFiles keeps the suite out of the developer's real user-level config (today: Claude Code's
// `~/.claude.json`, which the trust step would otherwise edit) — see test/helpers/setup-env.ts.
export default defineConfig({ test: { setupFiles: ["./test/helpers/setup-env.ts"] } });
