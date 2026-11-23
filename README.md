# SoXin (素心)

SoXin is a local memory system for everyday life. Report a meal, workout, or other update in Discord, recall it in a new conversation, and edit the underlying record in a dashboard. SoXin stores records in SQLite and sends selected context for each turn through the local Codex CLI.

## Run the dashboard

Use Node.js 24.17 or later and npm. The dashboard runs without Discord credentials or a Codex login.

```sh
npm ci
npm run build
npm start
```

Open [the local dashboard](http://127.0.0.1:4321). Select a collection to view and edit its records. Stop the service with Ctrl+C and run `npm start` again to reopen the same databases.

The defaults in [soxin.example.json](soxin.example.json) store data under `.local/data` and use the `Asia/Shanghai` timezone. Copy it to `soxin.local.json` to customize settings or set `SOXIN_CONFIG` to the path of another JSON configuration. Relative data directories resolve from the configuration file. Back up the data directory with SoXin and any MCP client stopped.

## Connect Discord and Codex

1. Install and sign in to the local Codex CLI. Run `codex --version` and `npm run check:codex` to check both model roles and confirm session resume with synthetic text.
2. Create a Discord bot, enable **Message Content Intent**, and install it in your test server with the `bot` and `applications.commands` scopes. Give it View Channel and Send Messages in the target text channels and Read Message History for message replies.
3. Copy `soxin.example.json` to `soxin.local.json`. Set `discord.allowedUser` to your Discord user ID and add your test channel IDs to `discord.allowedChannels`. Discord Developer Mode exposes the Copy ID commands.
4. Set `DISCORD_BOT_TOKEN` in your environment or add it to the ignored `.env` file in the checkout. Start SoXin with `npm start`.

If Discord needs a proxy, set `DISCORD_PROXY_URL` in `.env` to your HTTP proxy URL, for example `http://127.0.0.1:7890`. Restart SoXin to apply it to Discord REST requests, Gateway connections, and attachment downloads.

The defaults are `gpt-6.2-sol` for chat and `gpt-6-luna` for memory, both at `high`. The model roles have separate settings under `codex.chat` and `codex.memory`. If the CLI rejects the model or reasoning level, update the indicated role's settings and run `npm run check:codex` again. Set `codex.executable` to the executable path if Codex is unavailable on PATH.

Each allowed channel has its own active session. Use `/new` to start fresh or `/resume` to list recent sessions. Use `/resume session:<id>` to select one of those sessions. A fresh session can still recall saved records. SoXin accepts text, photos, and captions. Attach up to four PNG, JPEG, or WebP images per message, each at most 10 MiB.

Retrieval and extraction run concurrently. Retrieval selects records before the service commits any proposals from the same message. For example, a photo of today's lunch captioned “How does this compare with yesterday's lunch?” can retrieve yesterday's entry and separately record today's meal. Finance records hold reported monthly totals in integer minor units. SoXin can attach a partial breakdown to a reported total and leaves isolated payments out of the monthly totals.

The dashboard binds to loopback. Use a private Discord channel for personal messages. SQLite files are local, while Discord transports messages and the configured Codex models receive relevant message text, images, or selected records. The Codex CLI retains its resumable chat sessions in its own local store.

## Use the local MCP server

A trusted MCP client can start SoXin's database tools over stdio. Launch Node directly so stdout carries only MCP messages. The dashboard and bot can use the same data directory while the MCP server is running.

```json
{
  "mcpServers": {
    "soxin-records": {
      "command": "node",
      "args": ["/absolute/path/to/soxin/src/adapters/mcp.ts"],
      "env": { "SOXIN_CONFIG": "/absolute/path/to/soxin/soxin.local.json" }
    }
  }
}
```

Use absolute paths appropriate to the client. Omit `SOXIN_CONFIG` to use the checkout's local or example configuration. For a shell invocation from the checkout, use `npm run --silent mcp`.

The server exports `list_records`, `get_record`, `create_record`, `update_record`, and `delete_record` across all five domains. Update and delete require the current revision. Creating or replacing a current profile fact follows the same history rules as dashboard edits. The MCP server exposes writable records to its client. The built-in Discord turn runner reads through the repository and commits validated proposals with per-message deduplication.

## Verify the release

```sh
npm run typecheck
npm run build
npm test
```

The offline suite exercises all five databases, profile history, finance precision, conflicts, a photo turn with fake model runners, interrupted multi-database writes, session restoration, and the dashboard API and MCP server working against the same data. Tests use synthetic records and require loopback traffic for the API integration test.

The live Discord walkthrough requires the owner's test bot and channel. Send a text turn and a meal photo with a caption, start a new conversation, and ask about the meal. Edit its estimate in the dashboard, restart SoXin, then start a fresh conversation and retrieve the corrected estimate. Use `/resume` to return to an earlier session and confirm that a channel outside the allowlist cannot send turns or select sessions.

## Project documents

- [Design and memory fields](docs/design.md)
- [Owner decisions and open questions](docs/questions.md)
- [Contributor instructions](AGENTS.md)
- [First-release milestones and acceptance checks](docs/implementation-plan.md)
