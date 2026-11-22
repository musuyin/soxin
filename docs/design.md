# First-release design

## Adapters and memory processing

1. The Discord input adapter receives a channel message and passes its text, supported images, and conversation identity to retrieval and extraction. The two operations may begin together.
2. The memory model identifies relevant fields and records in local SQLite. Retrieval builds the chat input from the user's message and selected context. Archived profile rows can answer explicitly historical questions.
3. The chat adapter submits that input to the configured model. An adapter can wrap an API or CLI. The first adapter invokes the local Codex CLI and normally resumes the channel's session. Retrieval supplies the needed personal memory even on the first turn of a new session.
4. The Discord output adapter delivers the reply to the originating channel. Input and output may share a Discord client.
5. Extraction uses the memory model to propose structured additions or changes. Once retrieval for the same message has finished, the memory layer can persist them. It can commit as the chat adapter generates its reply.

Use Node.js and TypeScript. Both model roles use the local Codex CLI. Configuration files select GPT6.2 Sol with High reasoning for chat and GPT6 Luna with High reasoning for retrieval and extraction by default. In Discord, `/resume` selects an existing conversation and `/new` starts a fresh one. A new conversation can still retrieve the user's stored memories.

The memory runner returns structured retrieval queries and extraction proposals from isolated CLI invocations. The service bounds retrieved context, validates proposals, and commits them after retrieval. Each domain commits its applied marker and mutation in the same transaction. Service state preserves pending batches, the original read for pending turns, and channel session IDs across restarts.

Installing memory means adding selected records to the current prompt. Uninstalling means omitting them from that prompt. Both operations leave the stored records intact. A resumed CLI conversation can still contain context from earlier turns.

The [codex-discord bridge](https://github.com/musuyin/codex-discord) is a migration reference. Its Discord message handler and image attachment handler live under `src/bot/`. The Codex invocation lives in `src/adapters/codex-cli-adapter.ts`. The channel queue and session store are starting points for serializing channel turns and resuming the correct session. If importing upstream code, review the terms and preserve the attribution recorded in the bridge's `NOTICE.md`. SoXin should run independently of that repository after integration.

## Memory databases

Use a separate SQLite database for each domain. Each record below includes `Create` and `Update` timestamps. Event dates and reporting periods describe when something happened and can differ from the date the user reported it.

| Database | One record represents | Fields in addition to timestamps |
| --- | --- | --- |
| Profile | One version of a fact about the user | `Field` identifies the subject, `Tag` supports lookup, `Description` holds a few sentences, and `IsArchived` identifies historical versions. |
| Diet | One meal or snack | `MealDate` records the day the meal was eaten. `Type` identifies the meal. `Calorie` holds an estimated kcal count. `Description` lists components reported in text or inferred from a photo. |
| Finance | Income or expenses for one month | `Time` stores year and month, `Amount` is an integer, `Currency` defaults to CNY, and `Details` breaks down the total. Income and expense share this shape. |
| Workout | One workout | `Time` is the workout date, `Part` names the body areas trained, and `Description` records the exercises and sets. |
| Activity | One everyday event | `Time` supports a date and an approximate time such as dusk. `Event` summarizes the activity, `WithWho` names companions, `Location` gives the place, and `Note` captures the user's reflections. |

For each profile field, at most one row can have `IsArchived = false`. Updating the current value archives the old version. Ordinary retrieval uses the current version. Finance uses separate income and expense tables, each with a monthly total per currency and JSON details. The dashboard shows both tables on one page, formats CNY amounts such as 12.50, and renders details as rows. Store workout descriptions as plain text for the first release.

Finance amounts use integer minor units with currency-specific precision. The first release merges partial breakdowns into a previously reported monthly total. An isolated payment does not create or modify a monthly total.

## Database tools

A separate local stdio MCP entry point serves five tools for listing, reading, creating, updating, and deleting records. It takes the same configuration and calls the same SQLite repositories as the dashboard and turn handler. It checks revisions for edits and deletions, and follows the same profile history and finance constraints. The host launching the MCP process controls which client has access to these tools.

The built-in Discord workflow keeps database access inside the service. Chat receives the original message and selected records. The memory model requests bounded reads and proposes changes for the service to validate and commit.

## Dashboard

Start the dashboard together with the chat service. The owner can browse each domain, inspect a record, add a missing entry, correct a value such as a meal estimate, or delete an entry directly. These operations use local storage and require no LLM call.

The React dashboard uses a common monochrome and mint design system with ample spacing, thin borders, and a distinct active navigation item. The navigation collapses on narrow screens. Light and dark themes, visible keyboard focus, and reduced-motion support apply across the dashboard.

See the [implementation plan](implementation-plan.md) for screen behavior and the [owner's dashboard reference](assets/dashboard-reference.png) for layout.
