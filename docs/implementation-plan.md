# SoXin first-release implementation plan

The release is complete when the owner can report a meal in Discord, recall it in a fresh conversation, correct it in the local dashboard, and retrieve the correction after restarting SoXin. Build the five milestones in order. Verify each milestone with synthetic records before connecting a real account.

## 1. Establish a runnable local service

Use TypeScript on Node.js. As implementation defaults, use npm, a single service process, SQLite, and a React dashboard built with Vite and served by that process. Keep Discord transport, the Codex runner, memory repositories, and the dashboard HTTP API in separate modules. Share domain types and validation between the API and memory writes.

- Provide one example configuration with the data directory, local timezone, loopback dashboard port, allowed Discord user and channels, and independent chat and memory model settings. Read the Discord token from the environment.
- Use the local Codex CLI for both roles. Configure GPT6.2 Sol with High reasoning for chat and GPT6 Luna with High reasoning for memory. Verify the actual model identifiers and reasoning arguments against the installed CLI before shipping the example. Report which setting to correct if the CLI rejects it.
- Provide a single start command for the dashboard and bot. Keep the dashboard usable when Discord is disconnected or Codex is unavailable. Expose adapter errors without logging message bodies or credentials.

**Check** — Start from an empty data directory with Discord disconnected. Open the dashboard on localhost, see its empty state, stop the process, and start it again using the same configuration.

## 2. Implement storage and direct edits

Create one SQLite file per domain. Give each record a stable ID, creation and update timestamps, and a revision for conflict detection. Run versioned migrations on startup. Store audit timestamps in UTC and resolve relative event dates using the message timestamp and configured timezone. Implement list, get, create, update, and delete operations for the dashboard. Use parameterized queries and the same validation for extracted proposals.

| Domain | Storage contract and behavior |
| --- | --- |
| Profile | Store field, tag, description, and archive flag. Enforce at most one current row per field with a partial unique index. Replacing a current fact archives it and inserts its successor in one transaction. Expose history on request. |
| Diet | Store meal date separately from creation time, meal type, description, and optional estimated kcal. Preserve unknown estimates as empty. Resolve “yesterday” when processing the message, including a photo with a caption. |
| Finance | Create income and expense tables in the same file. Each table has one total per month and currency. Default to CNY. Use integer minor units with currency-aware decimal parsing and formatting. Store the breakdown as a JSON array of labeled items with optional amounts. Keep the reported total when only a partial breakdown is supplied. Distinguish a monthly total from an individual payment before updating it. |
| Workout | Store workout date, body area, and a plain-text description of exercises and sets. |
| Activity | Store the event, available date or approximate time, companions, location, and personal note. Preserve expressions such as “at dusk” without inventing a clock time or missing details. |

**Check** — Round-trip a record in each domain, reopen all five files, and read them again. Cover a backdated dinner, a profile correction with retained history, and CNY 12.50 stored as 1250. If two editors submit changes to the same revision, surface the conflict and preserve the first accepted edit.

## 3. Deliver one complete memory turn offline

Use a fake chat runner and memory runner first. Define the input once as a source message ID, channel and user IDs, message time, text, and optional image paths. Exercise the same turn handler later used by Discord.

1. Start retrieval and extraction concurrently. Run memory calls in fresh, isolated CLI invocations. Supply the schema to the memory model and validate its structured responses. The service owns database access. Retrieval requests specify a domain, supported filters, and a bounded result count. Extraction returns zero or more typed proposals. Resolve existing record IDs and revisions through repository lookups before applying updates.
2. Complete retrieval before writing any proposals from that turn. Build the chat input from the original message, images, and a bounded block of selected records. Omit the block when nothing is relevant. Keep retrieved text distinguishable from user instructions. Use current profile rows unless the user asks about the past.
3. After the read completes, start chat and commit validated proposals. Apply only supported facts or explicitly identified estimates. An invalid extraction must leave memory unchanged and still allow a chat reply. On retrieval failure, preserve existing memory and tell the user when a requested recall could not be completed.
4. Serialize turns within a channel through the end of memory processing. Use the source message ID and stable proposal index to make writes idempotent. Commit the applied marker and mutation together in each affected database. For multi-domain turns, retain the validated batch locally until all domains finish, so a retry can finish the same batch without re-extracting it. Skip stale revisions and surface conflicts instead of overwriting dashboard edits.

**Check** — Seed yesterday's lunch, then send today's photo with “How does this compare with yesterday?” Delay retrieval until extraction finishes. Assert that chat receives yesterday's entry, today's meal is written once, and redelivery creates no duplicate. Also test an empty retrieval, malformed extraction, and restart after the first domain of a two-domain batch commits.

## 4. Connect Discord and the real Codex CLI

Use the [bridge described in the design](design.md) as a migration reference. Port the pieces needed for user and channel admission, image handling, message splitting, per-channel queues, CLI execution, and persisted session IDs. Preserve applicable notices with copied code. Keep the resulting service runnable from a SoXin checkout alone.

- Give the runners separate working context from the private database directory. Pass only the selected records and necessary images. Keep inbound images available until both consumers finish, then remove the temporary copies.
- Persist the active chat session and known session IDs per channel. Resume the active session by default. Implement `/new` to start fresh while retaining the previous ID and `/resume` to select an earlier session belonging to that channel. If resume fails, report the failure and let the owner choose the next session.
- Deliver the final reply to the originating channel. Handle text-only, image-only, and captioned messages. Report unsupported attachments and CLI timeouts. A delivery retry must not repeat committed memory writes.

**Check** — In an allowed test channel, send text and a meal photo, start a new conversation, retrieve the meal, then return to the earlier conversation. Restart and verify session continuity. Verify an unauthorized channel cannot submit a turn or resume another channel's session. Keep offline adapter tests runnable without credentials.

## 5. Build and verify the dashboard

Use the [dashboard reference image](assets/dashboard-reference.png) for the proportions of the sidebar, header, cards, and content area. Apply the owner's Japanese minimalist direction through shared tokens for type, spacing, radius, borders, elevation, and color. Use black, white, and gray with restrained mint accents. Use a dark selected navigation row in light mode, a clearly distinct selection in dark mode, and thin borders around content cards.

| Surface | Behavior |
| --- | --- |
| Navigation | Put Overview and the five domains in a left rail. Show the active page in the header. On narrow screens collapse the rail into a labeled menu and stack cards and finance sections. |
| Overview | Use a compact row of cards linked to domain records, followed by recent entries. Derive counts and dates from local records. Empty cards lead to the corresponding domain's create action. |
| Domain pages | Show a record list, details, and create, edit, and delete actions. Use labeled forms, inline validation, explicit delete confirmation, and a refresh path after edit conflicts. Make archived profile history accessible from its field. |
| Finance | Show Income and Expenses as two blocks on the same page. Select month and currency, format amounts such as CNY 12.50, and display and edit the JSON breakdown as table rows. Keep currencies separate. |
| Theme and interaction | Support light and dark modes, visible keyboard focus, legible contrast, and named icon controls. Use Motion for brief hover and transition effects and respect reduced-motion preferences. |

**Release check** — Run type checking, build, and offline tests from a clean checkout. Exercise CRUD across all five pages with the model runner disabled. Check keyboard access and layout at phone and desktop widths in both themes. Finally run the Discord meal scenario at the top of this plan, including the dashboard correction and service restart. Document the verified setup and run commands in the README. Record any live checks that still require the owner's account.
