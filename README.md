# Swarm Chat Aggregator

The chat server for [swarm-chat-js](https://github.com/Solar-Punk-Ltd/swarm-chat-js) 7. Browsers send chat
messages as GSOC writes to one inbox address. This server listens on that inbox, checks every message, and
publishes each accepted one into its chat's Swarm feed, which browsers read. The browser only ever talks to
Swarm, through a gateway or its own Bee node.

## How it works

1. **Listening.** The server subscribes to the GSOC inbox on the listening node, the Bee node in the inbox
   address's neighbourhood. Every chat arrives through this one inbox, and the message's own `topic` says
   which chat it belongs to.
2. **Checking.** Each payload is checked by the library's message module (`@solarpunkltd/swarm-chat-js/message`):
   at most 2,048 bytes, UTF-8 JSON of the version 7 shape, and a signature that recovers the sender's `addr`.
   Then the server checks that the chat is allowed, that the sender's clock `ts` is within a day of its own,
   that the message is not a duplicate of one it already took (by `addr` and `id`), and that the chat and the
   sender are within their rates. Every drop is counted by its reason.
3. **Publishing.** Each chat has its own queue and publishes one message per feed slot, at indices 0, 1, 2 and
   on, under the server's feed key and `Topic.fromString(topic)`. Chats publish in parallel.
4. **History.** Each chat keeps its current history file in memory and saves a new copy after each publish.
   Every feed entry links the newest saved file, so a viewer opening the chat reads that file plus the entries
   after it.

### The feed entry

Written to slot `seq` of the chat's feed, always under 4,096 bytes so Bee never wraps it:

| Field     | Meaning                                                                          |
| :-------- | :------------------------------------------------------------------------------- |
| `v`       | `7`                                                                              |
| `seq`     | the message's number in this chat, equal to the feed index                       |
| `at`      | the server's receive time in milliseconds, the time a viewer shows               |
| `msg`     | the message exactly as received and verified                                     |
| `history` | `{ref, toSeq}` of the newest saved history file, or `null` before the first save |

The link trails by however many messages were published while the previous save was running.

### The history file

An ordinary Swarm upload of JSON: `{v: 7, topic, fromSeq, toSeq, messages: [{seq, at, msg}], prev}`. One save
runs at a time per chat, and messages published meanwhile ride the next save, so a burst costs at most two
saves. A file closes at 1,000 messages or 512 KB, and the next one starts with `prev` pointing at it. Files are
uploaded at the `INSANE` redundancy level.

A file that cannot be downloaded when a chat resumes, as when its stamp has expired, is retried with the resume,
and after `PUBLISH_ATTEMPTS` failures in a row the chat starts a fresh file whose `prev` points at the lost one.
The chat keeps publishing, the loss is logged as an error, and `/health` names the lost file as `historyLost`.

What history costs grows with the square of the chat's length, because each save uploads the whole current
file again: with messages of about 400 bytes a chat of N messages uploads about 400 × N² / 2 bytes of history
over its life, about 20 MB at 300 messages and about 200 MB at 1,000, before redundancy.

### Restarts and one writer

- **Checkpoints, written ahead.** Each chat has a small file in `CHECKPOINT_DIR`: the last slot that holds its
  entry, the entry about to be written, the newest history link and the rows published after it. The entry is
  recorded there before its slot is written, and the file is replaced atomically, written to a temporary file,
  flushed to disk and renamed. A restart continues exactly where the checkpoint says and reads nothing from the
  feed. A damaged checkpoint stops that chat on the health check and never starts it again at slot 0.
- **One entry per slot, and a stall rather than a gap.** Only the recorded entry is ever written to its slot,
  and it is resent unchanged, with a delay doubling up to 30 seconds, until one write succeeds, for as long as
  that takes. New messages queue behind it, and past `QUEUE_LIMIT` they are dropped and logged as dead letters
  with their ids. So a Bee that refuses writes pauses the chat instead of forking it or leaving a hole, and
  `/health` names the stuck slot, how long it has been stuck and how many attempts it took.
- **A chat without a checkpoint** asks Bee's head lookup and walks forward from there. A 404 from the lookup is
  not taken as a new chat on its own, because Bee answers 404 for a failed lookup too. A chat is new only when
  the lookup answered 404, slot 0 reads as absent twice a few seconds apart, the writing node answers ready with
  at least `MIN_CONNECTED_PEERS` connected peers, and the listening node cannot find slot 0 either. A node that
  cannot reach its peers reads every chunk as absent, which is why the absent answer needs that proof. Any other
  outcome leaves the chat unpublished and retried later, and a chat that does start this way says so in its log
  and on `/health`.
- **A slot is absent** only when two reads, `READ_RECHECK_MS` apart, both answer 404 or 500, since Bee answers a
  chunk it could not find either way depending on its version. Timeouts and gateway errors are failed reads,
  retried and never taken as absent.
- **Before writing a slot** the server reads it once. Absent means it writes. Its own bytes there mean an
  earlier attempt landed. Anything else means the slot is taken, so the server stops publishing that chat and
  says so on the health check. That is also what a checkpoint behind the feed meets, which the server stops at
  rather than overwrite.
- **The lock.** On start the server locks `CHECKPOINT_DIR` with a lock file holding a random instance id,
  refreshed every `LOCK_REFRESH_MS`. A start waits while a live holder keeps it fresh and then refuses. A lock
  older than `LOCK_STALE_MS` is taken over, which is how a restart after a kill gets in.

### Staying able to hear

A websocket dropped by a proxy never reports a close, so the server resubscribes whenever no frame has arrived
for `RESUBSCRIBE_IDLE_MS`, opening the new subscription before closing the old one. It also sends itself a
heartbeat every `HEARTBEAT_INTERVAL_MS` through the heartbeat node, which must be a different node from the
listening one. Heartbeats are `{v: 7, type: "heartbeat", nonce}`, recognised before any chat message, matched
against the nonces the server sent, counted, and never published.

### Health

`GET /health` on `HEALTH_PORT` answers 200 when all is well and 503 when no frame arrived, no heartbeat was
sent or none came back within `HEARTBEAT_STALE_MS`, or a chat cannot publish. Its JSON body carries the
seconds since the last frame, since the last heartbeat sent and received, the last send and subscribe errors,
each chat's state, next slot, queue depth, last publish and any stalled slot, and the counts of received,
published and dropped messages by reason.

### Shutdown

On `SIGTERM` or `SIGINT` the server stops taking messages, publishes what is queued and finishes the history
saves within `SHUTDOWN_DEADLINE_MS`, releases the lock, then exits. An entry still unwritten stays recorded in
the checkpoint and is sent first after the restart. What was still queued is dropped and logged as dead
letters.

## Settings

Environment variables, read once at start. A missing or malformed one stops the server with exit code 2 and
its name. A `.env` file in the working directory is read when it is there.

| Variable                 | Default         | Meaning                                                                                                                             |
| :----------------------- | :-------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| `LISTEN_BEE_URL`         | required        | the Bee node the server subscribes on, in the inbox address's neighbourhood                                                         |
| `WRITE_BEE_URL`          | required        | the Bee node that uploads feed entries and history files                                                                            |
| `HEARTBEAT_BEE_URL`      | required        | a different Bee node that heartbeats are sent through, the one browsers send through                                                |
| `WRITE_STAMP`            | required        | the postage batch id of the writing node, 64 hex characters                                                                         |
| `HEARTBEAT_STAMP`        | required        | a batch id the heartbeat node accepts                                                                                               |
| `FEED_KEY`               | required        | the private key the chat feeds are written under, 64 hex characters                                                                 |
| `GSOC_KEY`               | required        | the inbox's private key, public by design since every browser signs with it                                                         |
| `GSOC_IDENTIFIER`        | required        | the inbox's identifier string                                                                                                       |
| `CHAT_TOPICS`            | one of the two  | the allowed chats, a comma-separated list of topics                                                                                 |
| `CHAT_TOPIC_PATTERN`     | one of the two  | the allowed chats, a regular expression matched against the whole topic                                                             |
| `MAX_ACTIVE_CHATS`       | `50`            | how many chats outside `CHAT_TOPICS` the server publishes at once, listed chats are not counted                                     |
| `CHAT_IDLE_EVICT_MS`     | `600000`        | how long a chat outside `CHAT_TOPICS` must be quiet before it may be evicted to make room at the cap                                |
| `RATE_WINDOW_MS`         | `60000`         | the window the two rates count in                                                                                                   |
| `RATE_PER_CHAT`          | `600`           | messages per window in one chat                                                                                                     |
| `RATE_PER_SENDER`        | `30`            | messages per window from one sender in one chat                                                                                     |
| `QUEUE_LIMIT`            | `500`           | messages waiting per chat, past which more are dropped                                                                              |
| `RESUBSCRIBE_IDLE_MS`    | `180000`        | the silence after which the server resubscribes                                                                                     |
| `HEARTBEAT_INTERVAL_MS`  | `60000`         | how often a heartbeat is sent                                                                                                       |
| `HEARTBEAT_STALE_MS`     | `180000`        | how long without a frame or a heartbeat before health answers 503, over the interval                                                |
| `READ_RECHECK_MS`        | `3000`          | the gap between the two reads that confirm an empty slot                                                                            |
| `REQUEST_TIMEOUT_MS`     | `30000`         | the longest any one Bee request may take                                                                                            |
| `HISTORY_TIMEOUT_MS`     | `180000`        | the longest a history file's upload or download may take, a whole file with its parity rather than one chunk                        |
| `HISTORY_TRAIL_LIMIT`    | `500`           | rows published since the last saved history file past which `/health` warns, since each one is in the checkpoint until a save lands |
| `RESUME_RETRY_MS`        | `30000`         | how long a chat whose head is unknown waits before trying again                                                                     |
| `PUBLISH_ATTEMPTS`       | `6`             | attempts per history save, and feed-write attempts before a stalled slot turns health red                                           |
| `RETRY_BASE_MS`          | `1000`          | the first retry delay, doubling up to 30 seconds                                                                                    |
| `SHUTDOWN_DEADLINE_MS`   | `20000`         | how long a shutdown may spend publishing what is queued                                                                             |
| `LOCK_REFRESH_MS`        | `5000`          | how often the lock holder refreshes the lock                                                                                        |
| `LOCK_STALE_MS`          | `60000`         | how old a lock must be before a new start takes it over, over twice the refresh                                                     |
| `MIN_CONNECTED_PEERS`    | `8`             | connected peers the writing node needs before a chat with no checkpoint starts at slot 0, 1 on a two-node test cluster              |
| `CROSS_CHECK_TIMEOUT_MS` | `10000`         | the timeout of the second node's read of slot 0 for a chat with no checkpoint                                                       |
| `CHECKPOINT_DIR`         | `./checkpoints` | where the checkpoints and the lock live, a volume in a container                                                                    |
| `HEALTH_PORT`            | `3000`          | the port of `GET /health`                                                                                                           |

Seven settings replace variables of the 6.x server, which are no longer read:

- `LISTEN_BEE_URL` replaces `GSOC_BEE_URL`.
- `WRITE_BEE_URL` replaces `CHAT_BEE_URL`.
- `FEED_KEY` replaces `CHAT_KEY`.
- `WRITE_STAMP` replaces `CHAT_STAMP`.
- `GSOC_KEY` replaces `GSOC_RESOURCE_ID`.
- `GSOC_IDENTIFIER` replaces `GSOC_TOPIC`.
- `HEALTH_PORT` replaces `PORT`.

A known limit: with `CHAT_TOPIC_PATTERN`, anybody can open chats under invented topics until `MAX_ACTIVE_CHATS`
is reached. A quiet one is evicted to make room for the next chat, but a flood fast enough to fill the cap within
`CHAT_IDLE_EVICT_MS` holds new chats out until the invented ones go quiet, and `/health` says so. Chats listed in
`CHAT_TOPICS` are never held out, so listing the event's chats closes it.

The per-sender rate is weak, because a key costs nothing. The per-chat rate and the writing gateway's own
per-IP limit are the real brakes.

## Mining the inbox key

The inbox key must place the inbox address in the listening node's neighbourhood. After `pnpm build`:

```bash
pnpm mine --overlay <the listening node's overlay address> --identifier <GSOC_IDENTIFIER> --proximity 12
```

It prints the `GSOC_KEY` and `GSOC_IDENTIFIER` to set.

## Running

Node 24 and pnpm 12, which corepack takes from `packageManager`:

```bash
pnpm install
pnpm build
pnpm start
```

With Docker:

```bash
docker build -t swarm-chat-aggregator .
docker run -d --name swarm-chat-aggregator --env-file .env -v aggregator-checkpoints:/app/checkpoints \
  --restart unless-stopped swarm-chat-aggregator
```

Keep one container per feed key, with its checkpoint volume, and give it at least `LOCK_STALE_MS` to start after
a kill.

## Development

`pnpm lint`, `pnpm format`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` and `pnpm build`. The tests run
the whole server against a fake Bee over HTTP and a websocket, in `test/helpers/fakeBee.ts`.

The library is vendored as `vendor/solarpunkltd-swarm-chat-js-7.0.0.tgz` until 7.0.0 is published to npm.

## Further reading

- [Feeds](https://docs.ethswarm.org/docs/develop/tools-and-features/feeds#what-are-feeds)
- [GSOC](https://docs.ethswarm.org/docs/develop/tools-and-features/gsoc/#introduction)
- [swarm-chat-js](https://github.com/Solar-Punk-Ltd/swarm-chat-js)
