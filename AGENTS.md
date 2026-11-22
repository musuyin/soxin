# Working on SoXin

Write project documentation in English. Read the [design](docs/design.md) and the owner's answers in [open questions](docs/questions.md) before changing a component. Record unresolved questions in that file with space for an inline answer. The owner uses the document for clarification. Carry answered decisions into the design when implementing them.

- Follow the [first-release implementation plan](docs/implementation-plan.md) for build order and acceptance checks. Use the local Codex CLI for both model roles and keep Discord transport, chat execution, and memory handling independently replaceable.
- Pass the original input and retrieved memories to the chat adapter. Keep the chat model configurable independently of the model used for memory retrieval and extraction.
- Preserve read-before-write ordering for each incoming message. When replacing a profile field, archive its previous value and install the new current value in one transaction.
- Keep the SQLite records editable through the dashboard. Apply the same record invariants to dashboard edits and model-generated updates.
- Use synthetic records in examples and tests. Keep credentials, private databases, and cached attachments outside Git.
- Keep the README accurate about what can be run. Once an implementation exists, document and verify its actual startup and test commands.
