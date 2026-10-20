# Swarm Chat Aggregator

The chat server for [swarm-chat-js](https://github.com/Solar-Punk-Ltd/swarm-chat-js), the client library for chat on
[Swarm](https://www.ethswarm.org/), the decentralised storage network. Browsers send chat messages to one shared inbox
on Swarm. This server listens on that inbox, checks every message, and publishes each accepted one into its chat's
Swarm feed, which browsers read. The browser never talks to this server. It talks only to Swarm, through a gateway or
its own Bee node.

The library and this server together make a chat that any project can add to a site. One project built on them is
[stream-event-client](https://github.com/Solar-Punk-Ltd/stream-event-client), a viewer for live streams with a chat
beside each video.

## Terms

- **Bee node.** A Swarm node. A **gateway** is a Bee node that serves the public over HTTP.
- **Chunk.** The unit Swarm stores, at most 4,096 bytes, found by its address.
- **Single owner chunk.** A chunk whose address comes from an owner's key and an identifier, so only that key can write
  it.
- **GSOC.** A single owner chunk whose key is shared on purpose, so anyone can write to it. A Bee node near its address
  can subscribe to it over a websocket and hears every write. The chat's inbox is one GSOC address.
- **Neighbourhood.** The part of Swarm's address space a Bee node stores. A node hears GSOC writes only for addresses in
  its neighbourhood.
- **Feed.** A sequence of single owner chunks written by one owner under one topic, at index 0, 1, 2 and on. Each chat
  is one feed, and this server is its only writer. An index of the feed is called a slot here.
- **Postage stamp.** Every write to Swarm is paid for with a stamp from a postage batch, named by its batch id.

## What you need

- **A listening node**, the Bee node this server subscribes on. It must be a full node, because only full nodes store
  their neighbourhood's chunks and so hear GSOC writes. The inbox address must fall in its neighbourhood, which
  [Mining the inbox key](#mining-the-inbox-key) arranges.
- **A writing node** with a postage batch, which uploads feed entries, history files and slot notes.
- **A heartbeat node** with a batch it accepts. The server sends itself a test message through it every
  `HEARTBEAT_INTERVAL_MS`, a minute by default, to prove the inbox still works.
- **A node for browsers to send through.** Browsers write to the inbox through a gateway or their own Bee node. The
  heartbeat node is usually that same node, so the heartbeat tests the path messages take.
- **Send through a different node from the listening one.** Bee accepts a write to the inbox on any node, but it hands
  a write to the inbox's subscribers only when the chunk arrives from another node. A write made on the listening node
  itself is sent on to a peer first, so the listener hears it only if it later syncs back. Messages and heartbeats
  therefore go through a node other than the listening node.
- **A feed key**, the private key the chat feeds are written under. Readers name its address as the chat's feed owner.
- **Node 24**, or Docker.

## How it works

1. **Listening.** The server subscribes to the inbox on the listening node. Every chat arrives through this one inbox,
   and each message's `topic` says which chat it belongs to.
2. **Checking.** Each payload is checked by the library's message module (`@solarpunkltd/swarm-chat-js/message`): at
   most 3,072 bytes, UTF-8 JSON of the version 9 shape, a signature that recovers the sender's `addr`, and, when the
   message carries a Swarm ID binding, a binding that names this `addr` and recovers an account. A message of any other
   version is refused as `shape`, and one whose binding fails is refused as `binding`.
3. **One site.** A binding must also name the site in `CHAT_SITE_ORIGIN`, because the server serves the chats of one
   site. So a sender signed in on another site cannot carry that identity into these chats. `CHAT_SITE_ORIGIN` is
   required. A binding for `http://localhost` is accepted only when `CHAT_SITE_ORIGIN` names that local origin, as a
   development build does.
4. **Admission.** The server then checks that the chat is allowed, that the sender's clock `ts` is within a day of its
   own, that the message is not a duplicate of one it already took (by `addr` and `id`), and that the chat and the
   sender are within their rates. Every drop is counted by its reason.
5. **Publishing.** Each chat has its own queue and publishes one message per feed slot, at indices 0, 1, 2 and on, under
   the feed key and `Topic.fromString(topic)`. Chats publish in parallel.
6. **History.** Each chat keeps its current history file in memory and saves a new copy after each publish. Every feed
   entry links to the newest saved file, so a viewer opening the chat reads that file plus the entries after it.
7. **Slot notes.** Once a time slot of `NOTE_SLOT_MS` ends in which a message landed, and at least every
   `NOTE_HEARTBEAT_MS` while a chat is active, the server writes a small note naming the chat's newest feed slot.
   Viewers read only the notes of slots that are over, and only the entries a note named, so nobody asks Bee for an
   entry before it exists.

### The feed entry

Written to slot `seq` of the chat's feed, always under 4,096 bytes so it fits in one chunk:

| Field     | Meaning                                                                          |
| :-------- | :------------------------------------------------------------------------------- |
| `v`       | `9`                                                                              |
| `seq`     | the message's number in this chat, equal to the feed index                       |
| `at`      | the server's receive time in milliseconds, the time a viewer shows               |
| `msg`     | the message exactly as received and verified, every field kept                   |
| `history` | `{ref, toSeq}` of the newest saved history file, or `null` before the first save |

The link can trail by the messages published while the previous save was running.

### The message

`msg` is the library's version 9 chat message, published exactly as it arrived. The server adds nothing to it. The entry
around it adds only `seq` and `at` beside the `v` and `history` every entry has. The library's README describes each
field in full.

| Field    | Meaning                                                                                           |
| :------- | :------------------------------------------------------------------------------------------------ |
| `v`      | `9`                                                                                               |
| `topic`  | the chat, 1 to 128 characters                                                                     |
| `id`     | the message id, 32 lowercase hex characters, which with `addr` makes the duplicate check          |
| `type`   | `text`, `thread` or `reaction`                                                                    |
| `target` | the id a thread reply or a reaction refers to, empty for a text message                           |
| `text`   | 1 to 500 characters                                                                               |
| `name`   | the display name, 1 to 20 characters                                                              |
| `addr`   | the sender's chat address, 40 lowercase hex characters                                            |
| `ts`     | the sender's clock in milliseconds, within a day of the server's                                  |
| `via`    | who paid for the inbox write, `gateway` or `own-stamp`                                            |
| `idb`    | the sender's Swarm ID binding `{msg, sig}`, only for a signed-in sender                           |
| `wl`     | the sender's wallet link `{msg, wsig, asig}`, only beside `idb`, for a sender who linked a wallet |
| `sig`    | the sender's signature over every field above, 130 lowercase hex characters                       |

Every field but `sig` is signed, `via`, `idb` and `wl` included, so none can change on the way.

### The history file

A history file is an ordinary Swarm upload of JSON: `{v: 9, topic, fromSeq, toSeq, messages: [{seq, at, msg}], prev}`.

- One save runs at a time per chat. Messages published during a save go into the next save, so a burst costs at most
  two saves.
- A busy chat saves at most once per `HISTORY_SAVE_INTERVAL_MS`, so history uploads do not crowd out feed writes on the
  same node.
- A file closes at 1,000 messages or 512 KB, and the next one starts with `prev` pointing at it.
- Files are uploaded with Bee's highest redundancy level, `INSANE`, so they survive missing chunks.

When a chat resumes and its history file cannot be downloaded, for example because its stamp has expired, the download
is retried with the resume. After `PUBLISH_ATTEMPTS` failures in a row the chat starts a fresh file whose `prev` points
at the lost one. The chat keeps publishing, the loss is logged as an error, and `/health` names the lost file as
`historyLost`.

History costs grow with the square of a chat's length, because each save uploads the whole current file again. With
messages of about 400 bytes, a chat of N messages uploads about 400 × N² / 2 bytes of history over its life. That is
about 20 MB at 300 messages and about 200 MB at 1,000, before redundancy.

### Slot notes

When Bee is asked for a chunk it cannot find, it skips each peer it asked for that address for about a minute. A
viewer that asked for the next feed slot before it was written would therefore get the message tens of seconds late.
Slot notes tell viewers which slots exist, so every read goes to an address that is already written.

- **The note.** Time slot `s` covers `[s * NOTE_SLOT_MS, (s + 1) * NOTE_SLOT_MS)` of Unix time. Its note is a single
  owner chunk under the feed key at the identifier keccak256(`<topic>/note/<NOTE_SLOT_MS>/<s>`), holding
  `{"v":1,"newest":<the newest confirmed feed slot>,"writtenAt":<the server's clock>}`. The library's message module
  defines it, and this server imports it.
- **When.** Once a slot ends, its note is written if a slot was confirmed since the last note, or if
  `NOTE_HEARTBEAT_MS` has passed since that note. Only confirmed slots are named, so an entry's write has finished
  before any note names it.
- **A failed note** is never written again at its address, where a viewer may already have been told it is missing.
  The next slot's note carries the same information, and so does every following slot's until one is written.
- **Active** means the chat's publisher is loaded and ready, and not stopped, blocked or evicted. A chat in
  `CHAT_TOPICS` is opened when the server starts, so it writes notes before any message, with `newest` -1 while it has
  none. A chat matched only by `CHAT_TOPIC_PATTERN` is opened by its first message after the start. Until then its
  viewers find no note and follow it by polling.
- **What it costs.** One chunk of the feed stamp per note. A quiet active chat writes one every `NOTE_HEARTBEAT_MS`,
  2,880 a day at the default. A chat busy in every slot writes one every `NOTE_SLOT_MS`, at most 43,200 a day. `/health`
  gives each chat's notes written, notes failed, the last note's time and the last error.

### Restarts and one writer

- **Checkpoints, written ahead.** Each chat has a small file in `CHECKPOINT_DIR` holding the last slot confirmed in
  order, the entries in flight with their exact bytes, the newest history link, and the rows published after it. An
  entry is recorded there before its slot is first written. The file is replaced atomically: written to a temporary
  file, flushed to disk and renamed. A restart continues exactly where the checkpoint says, resends every entry in
  flight with its own bytes, and reads nothing else from the feed. A damaged checkpoint, including a list of entries
  that does not run on slot by slot from the last confirmed one, stops that chat on the health check and never starts
  it again at slot 0.
- **Several slots in flight, confirmed in order.** Up to `PUBLISH_WINDOW` slots of one chat are written at once, so a
  burst is not paced by one write at a time. Slots can land in any order. A slot counts as confirmed only once every
  slot before it has landed, so the checkpoint's last confirmed slot only moves forward over slots that all hold their
  entries. A viewer may see a later slot a moment before an earlier one fills in.
- **One entry per slot, and a stall rather than a gap.** Only a slot's recorded entry is ever written to it. It is resent
  unchanged, with a delay doubling up to 30 seconds, until one write succeeds. Messages past the window queue behind it,
  and past `QUEUE_LIMIT` they are dropped and logged as dead letters with their ids. So a Bee node that refuses writes
  pauses the chat instead of forking it or leaving a hole, and `/health` names the first stuck slot, how long it has
  been stuck and how many attempts it took.
- **A chat without a checkpoint** asks Bee for the feed's newest index and walks forward from there. A 404 from that
  lookup does not mean a new chat on its own, because Bee also answers 404 when the lookup fails. A chat is new only
  when the lookup answered 404, slot 0 reads as absent twice `READ_RECHECK_MS` apart, the writing node answers ready
  with at least `MIN_CONNECTED_PEERS` connected peers, and one read on the listening node cannot find slot 0 either. A
  node that cannot reach its peers reads every chunk as absent, which is why the absent answer needs that proof. Any
  other outcome leaves the chat unpublished and retried later. A chat that does start this way says so in its log and on
  `/health`.
- **What these checks cost.** They run only when a chat with no checkpoint is opened: at the start for a chat in
  `CHAT_TOPICS`, and on its first message for any other. In normal operation that is once in a chat's life. A restart or
  an evicted chat resumes from its checkpoint without them, and a message in a running chat costs no read at all.
  Before a new chat writes its first message, the server makes six requests to Bee: the newest-index lookup, two reads
  of slot 0 one `READ_RECHECK_MS` apart, the writing node's readiness, its peer count, and one read of slot 0 through
  the listening node. So the first message of a new chat waits about one second, the `READ_RECHECK_MS` default, plus
  however long those six requests take.
- **A slot is absent** only when two reads, `READ_RECHECK_MS` apart, both answer 404 or 500, since Bee answers a chunk
  it could not find with either, depending on its version. Timeouts and gateway errors are failed reads, retried and
  never taken as absent. A slot is read twice only where absence decides where a chat starts.
- **Reading a slot before writing it** happens where it protects the feed: before the first writes after a chat
  resumes, including every entry the checkpoint held in flight, until a slot is confirmed, and before every attempt
  after a failed write. Absent means the server writes. Its own bytes there mean an earlier attempt landed. Anything
  else means the slot is taken, so the server stops publishing that chat and says so on the health check. That is what
  a checkpoint that is behind the feed runs into, and the server stops rather than overwrite. A running chat writes its
  next slot without reading it, since reading an address not yet written makes Bee skip its peers for it, and the lock
  keeps this server the feed's only writer.
- **The lock.** On start the server locks `CHECKPOINT_DIR` with a lock file holding a random instance id, refreshed
  every `LOCK_REFRESH_MS`. A second start waits while a live holder keeps it fresh, and then refuses. A lock older than
  `LOCK_STALE_MS` is taken over, which is how a restart after a kill gets in.

### Staying able to hear

A websocket dropped by a proxy never reports a close. So the server resubscribes whenever no frame has arrived for
`RESUBSCRIBE_IDLE_MS`, opening the new subscription before closing the old one. It also sends itself a heartbeat every
`HEARTBEAT_INTERVAL_MS` through the heartbeat node. Heartbeats are `{v: 9, type: "heartbeat", nonce}`. They are
recognised before any chat message, matched against the nonces the server sent, counted, and never published.

### Health

`GET /health` on `HEALTH_PORT` answers 200 when all is well. It answers 503 when no frame arrived, no heartbeat was sent
or none came back within `HEARTBEAT_STALE_MS`, or a chat cannot publish. Its JSON body carries:

- the seconds since the last frame, and since the last heartbeat sent and received
- the last send and subscribe errors
- each chat's state, next slot, queue depth, last publish and any stalled slot
- the counts of received, published and dropped messages, by reason

Its `observations` block gives, per chat, the p50, p90 and maximum of each stage of its last 500 publishes: the read
before the write (zero in a running chat), the two checkpoint writes, the feed write, and the whole time from receipt
to the entry landing. These are reported for operators and never change what the server does.

After a restart, look at each chat's `historyLost`. It is the one problem that does not turn `/health` red. It names a
history file the chat could not download, so viewers loading older messages stop at that file while the chat keeps
publishing. A chat that works should not read 503 for the rest of the process, which is why this is a field and not a
failure.

### Shutdown

On `SIGTERM` or `SIGINT` the server stops taking messages and spends up to `SHUTDOWN_DEADLINE_MS` publishing what is
queued and finishing the history saves. At the deadline it drops what is still queued, logged as dead letters. It then
waits for any Bee request already sent to answer, which `REQUEST_TIMEOUT_MS` bounds, so the checkpoint records whatever
landed before it releases the lock and exits. A whole stop can therefore take up to about `SHUTDOWN_DEADLINE_MS` plus
`REQUEST_TIMEOUT_MS`. An entry still unwritten stays in the checkpoint and is sent first after the restart.

A stop cut short by a kill or a crash loses what was queued, without a dead-letter line. It never breaks the feed's
consistency, which the checkpoint keeps.

## Settings

Environment variables, read once at start. A missing or malformed one stops the server with exit code 2 and its name.
A `.env` file in the working directory is read when it is there. `.env.sample` lists every variable.

| Variable                   | Default         | Meaning                                                                                                                                                                                                            |
| :------------------------- | :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LISTEN_BEE_URL`           | required        | the Bee node the server subscribes on, in the inbox address's neighbourhood                                                                                                                                        |
| `WRITE_BEE_URL`            | required        | the Bee node that uploads feed entries and history files                                                                                                                                                           |
| `HEARTBEAT_BEE_URL`        | required        | a Bee node other than the listening one that heartbeats are sent through, usually the one browsers send through                                                                                                    |
| `WRITE_STAMP`              | required        | the postage batch id of the writing node, 64 hex characters                                                                                                                                                        |
| `HEARTBEAT_STAMP`          | required        | a batch id the heartbeat node accepts                                                                                                                                                                              |
| `FEED_KEY`                 | required        | the private key the chat feeds are written under, 64 hex characters                                                                                                                                                |
| `GSOC_KEY`                 | required        | the inbox's private key, public by design since every browser signs with it                                                                                                                                        |
| `GSOC_IDENTIFIER`          | required        | the inbox's identifier string                                                                                                                                                                                      |
| `CHAT_TOPICS`              | one of the two  | the allowed chats, a comma-separated list of topics                                                                                                                                                                |
| `CHAT_TOPIC_PATTERN`       | one of the two  | the allowed chats, a regular expression matched against the whole topic. Anyone can open a chat under a matching topic, up to `MAX_ACTIVE_CHATS`, so list your own chats in `CHAT_TOPICS` to keep them always open |
| `CHAT_SITE_ORIGIN`         | required        | the site the chats are served for, such as `https://chat.example.com`, the only site whose Swarm ID bindings are accepted, https with a DNS host or http on localhost                                              |
| `MAX_ACTIVE_CHATS`         | `50`            | how many chats outside `CHAT_TOPICS` the server publishes at once, listed chats are not counted                                                                                                                    |
| `CHAT_IDLE_EVICT_MS`       | `600000`        | how long a chat outside `CHAT_TOPICS` must be quiet before it may be evicted to make room at the cap                                                                                                               |
| `RATE_WINDOW_MS`           | `60000`         | the window the two rates count in                                                                                                                                                                                  |
| `RATE_PER_CHAT`            | `600`           | messages per window in one chat                                                                                                                                                                                    |
| `RATE_PER_SENDER`          | `30`            | messages per window from one sender in one chat                                                                                                                                                                    |
| `QUEUE_LIMIT`              | `500`           | messages waiting per chat, past which more are dropped                                                                                                                                                             |
| `PUBLISH_WINDOW`           | `8`             | how many slots of one chat may be in flight at once, each with its own entry, confirmed in slot order                                                                                                              |
| `RESUBSCRIBE_IDLE_MS`      | `180000`        | the silence after which the server resubscribes                                                                                                                                                                    |
| `HEARTBEAT_INTERVAL_MS`    | `60000`         | how often a heartbeat is sent                                                                                                                                                                                      |
| `HEARTBEAT_STALE_MS`       | `180000`        | how long without a frame or a heartbeat before health answers 503, over the interval                                                                                                                               |
| `READ_RECHECK_MS`          | `1000`          | the gap between the two reads that confirm an empty slot, paid only where absence decides where a chat starts                                                                                                      |
| `REQUEST_TIMEOUT_MS`       | `30000`         | the longest any one Bee request may take                                                                                                                                                                           |
| `HISTORY_TIMEOUT_MS`       | `180000`        | the longest a history file's upload or download may take, a whole file with its parity rather than one chunk                                                                                                       |
| `HISTORY_TRAIL_LIMIT`      | `500`           | rows published since the last saved history file past which `/health` warns, since each one is in the checkpoint until a save lands                                                                                |
| `HISTORY_SAVE_INTERVAL_MS` | `5000`          | the least time between two history uploads of one chat while it is busy, a quiet chat saves at once                                                                                                                |
| `RESUME_RETRY_MS`          | `30000`         | how long a chat whose head is unknown waits before trying again                                                                                                                                                    |
| `PUBLISH_ATTEMPTS`         | `6`             | attempts per history save, and feed-write attempts before a stalled slot turns health red                                                                                                                          |
| `RETRY_BASE_MS`            | `1000`          | the first retry delay, doubling up to 30 seconds                                                                                                                                                                   |
| `SHUTDOWN_DEADLINE_MS`     | `20000`         | how long a shutdown may spend publishing what is queued                                                                                                                                                            |
| `LOCK_REFRESH_MS`          | `5000`          | how often the lock holder refreshes the lock                                                                                                                                                                       |
| `LOCK_STALE_MS`            | `60000`         | how old a lock must be before a new start takes it over, over twice the refresh                                                                                                                                    |
| `MIN_CONNECTED_PEERS`      | `8`             | connected peers the writing node needs before a chat with no checkpoint starts at slot 0, 1 on a two-node test cluster                                                                                             |
| `CROSS_CHECK_TIMEOUT_MS`   | `10000`         | the timeout of the second node's read of slot 0 for a chat with no checkpoint                                                                                                                                      |
| `CHECKPOINT_DIR`           | `./checkpoints` | where the checkpoints and the lock live, a volume in a container                                                                                                                                                   |
| `NOTE_SLOT_MS`             | `2000`          | the length of a slot note's time slot, part of every note's address, so viewers must use the same value                                                                                                            |
| `NOTE_HEARTBEAT_MS`        | `30000`         | the longest an active chat goes without a note, at least `NOTE_SLOT_MS`, which bounds what a lost note costs a viewer                                                                                              |
| `HEALTH_PORT`              | `3000`          | the port of `GET /health`. It listens on every interface, so keep this port closed on the public interface                                                                                                         |

A server from the 6.x line of swarm-chat-js read seven of these under other names, which this server does not read:
`GSOC_BEE_URL` is now `LISTEN_BEE_URL`, `CHAT_BEE_URL` is `WRITE_BEE_URL`, `CHAT_KEY` is `FEED_KEY`, `CHAT_STAMP` is
`WRITE_STAMP`, `GSOC_RESOURCE_ID` is `GSOC_KEY`, `GSOC_TOPIC` is `GSOC_IDENTIFIER`, and `PORT` is `HEALTH_PORT`.

## Mining the inbox key

The inbox key must place the inbox address in the listening node's neighbourhood. After `pnpm build`:

```bash
pnpm mine --overlay <the listening node's overlay address> --identifier <GSOC_IDENTIFIER> --proximity 12
```

The overlay address is the listening node's address in Swarm, the `overlay` field of its `GET /addresses` answer. `--proximity` is how
many leading bits the inbox address must share with it, 12 by default. The command prints the `GSOC_KEY` and
`GSOC_IDENTIFIER` to set. Give the same key and identifier to the pages that use the library, as `gsocResourceId` and
`gsocTopic`. The key is public by design, since every sender signs inbox writes with it.

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
  --stop-timeout 60 --restart unless-stopped swarm-chat-aggregator
```

Docker kills a container 10 seconds after `docker stop` unless told otherwise, which is too short for a clean shutdown.
Set `--stop-timeout`, or `stop_grace_period` in Compose, above `SHUTDOWN_DEADLINE_MS` plus `REQUEST_TIMEOUT_MS`. That is
50 seconds with the defaults, so 60 above. Run one container per feed key, with its own checkpoint volume, and give it at
least `LOCK_STALE_MS` to start after a kill.

## Development

`pnpm lint`, `pnpm format`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` and `pnpm build`. The tests run the whole
server against a fake Bee over HTTP and a websocket, in `test/helpers/fakeBee.ts`.

`pnpm bench` sends a burst of 200 messages from 20 senders over two seconds, with the senders' resends, to a fake
writing node that pushes one chunk at a time. It prints where the time went: the intake per frame, the feed writes, the
time from receipt to write, each message's first send to the feed against the senders' 60 second window, and the
chunks the node pushed. It asserts only that every message landed once, and it is not part of `pnpm test`.

The message library is `@solarpunkltd/swarm-chat-js` 9.0.0 from npm. `pnpm-workspace.yaml` installs no version younger
than one week, and exempts this one package because the same team publishes it.

## Live test bed

`pnpm test:docker` runs the chat against real Bee nodes on a local test chain, so no real BZZ, Swarm's token, is spent.
It needs a Docker daemon it can reach.

- **The cluster** is [fdp-play](https://github.com/fairDataSociety/fdp-play)'s local chain and three full Bee nodes, made
  from fdp-play's own node images, whose keys that chain funded. The server listens on one node and writes through
  another.
- **The scenarios** are B1 to B4: many senders at once, a server restart, a listening connection that dies without a
  close, and a malformed and a forged message. Each passes only when the chat feed holds every valid message exactly
  once, overwrites no slot and holds nothing else. A sender that gave up on a message that still reached the feed is
  reported with its count and how far past the senders' window the message landed, and is not a failure. Timings are
  printed and never asserted, so runs of two commits compare on numbers rather than on pass or fail.
- **Bee is built from source, not taken from the released image.** The bed builds Bee v2.8.3 at commit `8e9bb914` by
  default, with `REACHABILITY_OVERRIDE_PUBLIC=true`, the setting fdp-play uses for its own local clusters. A released
  Bee never counts itself reachable on a private network, so it never stores a chunk pushed to it, and every push loops
  between the nodes until it gives up. The source is pinned by commit and the Go image by digest. `node test/live/bed.mjs --bee 2.8.2`, after `pnpm build`, builds v2.8.2 at `7e703f49` instead.
- **`node test/live/spike.mjs`** checks whether a Bee release runs on that chain at all. It runs the built 2.8.3 and
  2.8.2 and the released 2.6.0 image, which is expected to fail and shows the failure the build gets past.
- **What a run keeps:** every node's whole log, and each node's status, peer statuses and topology, in `test-results/`,
  which git ignores.

## Further reading

- [swarm-chat-js](https://github.com/Solar-Punk-Ltd/swarm-chat-js), the client library
- [Feeds](https://docs.ethswarm.org/docs/develop/tools-and-features/feeds#what-are-feeds)
- [GSOC](https://docs.ethswarm.org/docs/develop/tools-and-features/gsoc/#introduction)
