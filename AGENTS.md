# AGENTS.md

Read by AI coding agents and by people working in this repository. `CLAUDE.md` is the one line
`@AGENTS.md`, so every tool reads the same text.

## What this is

The chat server for swarm-chat-js 7. It listens on one GSOC inbox, checks each chat message, and
publishes the accepted ones into each chat's Swarm feed, one slot per message, with a history file
beside it. The README describes the behaviour, the feed entry, the history file and every setting.

## Where the contract lives

The message, its signed bytes, its checks and its caps belong to the library's message module,
`@solarpunkltd/swarm-chat-js/message`. This server imports it and keeps no copy. A change to the
message format is made in the library first.

## Branches

- `master` is the base of this line. The `msrs` branch is another deployment's server and is never
  merged into or out of.
- Pushes to `prod` and `test` deploy, and `docker-build` and `v*` tags build images. Nobody pushes those
  without the owner's word.

## Rules that keep the feed safe

- Never write a feed slot without reading it first, and never overwrite a slot holding bytes this server
  did not write. A slot is empty only when two reads a few seconds apart answer 404.
- Never resume a chat from Bee's head lookup alone, and never start a chat at slot 0 unless the lookup
  and two reads of slot 0 all say it is empty. The checkpoint is the primary record.
- A retry resends the identical entry bytes, never a rebuilt entry.
- Never send a GSOC or feed write deferred.
- Every Bee request carries its own timeout signal, because bee-js sets none.
- Whether a failed read means empty, failed or taken is decided in one function,
  `slotReadFromError` in `src/feed/slots.ts`.

## Working here

- Node 24 and pnpm 12 from `packageManager`. `pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
  `pnpm test` and `pnpm build` are what CI runs.
- Tests run the whole server against the fake Bee in `test/helpers/fakeBee.ts`. A behaviour change comes
  with a test that fails without it.
- When a setting changes, change the README table and `.env.sample` in the same commit. A test compares
  both with the code.
- Real host names, addresses, keys and stamp ids stay out of the repository. Tests make their own keys.
- Commits follow the conventional style, one logical change each.
- A comment carries context the code cannot, never a narration of the line below it.
