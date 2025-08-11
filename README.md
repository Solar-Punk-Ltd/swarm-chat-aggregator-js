# Swarm Chat JS: Example GSOC Aggregator Server 🐝💬

This project provides an example implementation of a GSOC aggregator server designed to work with the [Solar-Punk-Ltd/swarm-chat-js](https://github.com/Solar-Punk-Ltd/swarm-chat-js) library.

The primary function of this server is to receive messages sent by chat users via GSOC and consolidate them into a more persistent, access-controlled Swarm feed (the "chat feed"). This aggregator can manage multiple chat topics under a single GSOC node.

**Note:** This is an example implementation. For production environments, consider enhancing aspects like batch processing, message validation, schema enforcement, and feed writing policies.

---

## ⚙️ How It Works

The aggregator server operates through the following steps:

1.  **GSOC Subscription:** The server connects to a specified Bee node (`GSOC_BEE_URL`) and subscribes to updates on a particular GSOC resource (`GSOC_RESOURCE_ID`) and topic (`GSOC_TOPIC`). This GSOC feed is where chat users publish their messages.
2.  **Message Reception:** As new messages arrive on the GSOC feed, the server receives them.
3.  **Message Processing:** The server expects incoming messages to contain a `chatTopic` field (e.g., `parsed.chatTopic`), indicating the specific chat room or topic the message belongs to. This allows the aggregator to handle multiple distinct chat conversations.
4.  **Message State Management:** The server maintains a complete message history across multiple Swarm references. This history includes all types of messages (reactions, threads, and regular messages). When the accumulated message state exceeds the configurable size limit (10MB by default), a new reference is created to prevent individual references from becoming too large. This creates an array of timestamped references, with only the latest reference being actively updated.
5.  **Chat Feed Writing:** Valid messages are then written to a separate, designated Swarm feed (the "chat feed"). This feed is managed by a different Bee node (`CHAT_BEE_URL`) and secured with a private key (`CHAT_KEY`), ensuring that only authorized entities (like this aggregator) can write to it. The message state history is stored as an array of references (`ReactionStateRef[]`) rather than a single reference, enabling scalable message history management. Writes to this feed require a valid postage stamp (`CHAT_STAMP`).

This setup allows for a public message submission mechanism via GSOC, with a backend aggregator ensuring messages are collected and stored reliably on a more controlled Swarm feed with efficient handling of large message histories.

---

## 📊 Message State Management

The aggregator implements an advanced message state management system designed to handle large volumes of all message types (reactions, threads, and regular messages) efficiently:

### Multi-Reference Architecture

- **Reference Array:** Instead of storing all message history in a single Swarm reference, the system maintains an array of `ReactionStateRef` objects
- **Size-Limited References:** Each reference is limited to 10MB (configurable via `maxReactionStateSize`) to prevent performance issues
- **Automatic Splitting:** When adding a new message would exceed the size limit, a new reference is created automatically
- **Complete History:** Each reference contains a complete snapshot of message history up to that point
- **Timestamp Tracking:** Each reference includes a timestamp for chronological ordering and identification of the latest state

### State Structure

Each `ReactionStateRef` contains:

```typescript
{
  reference: string; // Swarm reference hash pointing to MessageData[]
  timestamp: number; // Creation timestamp
}
```

The referenced data contains an array of `MessageData` objects representing the complete message history.

### Initialization Behavior

- **Latest State Loading:** During topic initialization, only the chronologically latest reference is downloaded and loaded into memory
- **Complete History Access:** While only the latest state is actively loaded, the full message history remains accessible through previous references
- **Performance Optimization:** Historical message states remain on Swarm but are not loaded, reducing memory usage
- **Seamless Recovery:** The system can resume from any existing state without data loss

---

## 🔧 Configuration

The server requires the following environment variables to be set:

| Variable           | Description                                                                      |
| :----------------- | :------------------------------------------------------------------------------- |
| `GSOC_BEE_URL`     | The URL of the Bee node used for GSOC operations (subscribing to user messages). |
| `GSOC_RESOURCE_ID` | The mined Swarm resource ID of the GSOC feed the aggregator listens to.          |
| `GSOC_TOPIC`       | The specific topic hash on the GSOC feed that this aggregator monitors.          |
| `CHAT_BEE_URL`     | The URL of the Bee node used for writing to the consolidated chat feed.          |
| `CHAT_KEY`         | The private key used to sign updates to the consolidated chat feed.              |
| `CHAT_STAMP`       | The postage stamp ID used for uploading content to the chat feed.                |

## 🚀 Running the Aggregator

### Option 1: Node.js (Direct)

1.  **Clone the repository:**
    ```bash
    git clone git@github.com:Solar-Punk-Ltd/swarm-chat-aggregator-js.git
    cd swarm-chat-aggregator-js
    ```
2.  **Install dependencies:**
    ```bash
    pnpm install
    ```
3.  **Set up your environment variables:**
    Create a `.env` file in the root of the project with the variables listed above, or set them in your deployment environment.
4.  **Build the server:**
    ```bash
    pnpm build
    ```
5.  **Start the server:**
    ```bash
    pnpm start
    ```

### Option 2: Docker

1.  **Clone the repository:**

    ```bash
    git clone git@github.com:Solar-Punk-Ltd/swarm-chat-aggregator-js.git
    cd swarm-chat-aggregator-js
    ```

2.  **Set up your environment variables:**
    Create a `.env` file in the root of the project with the required variables.

3.  **Build and run with Docker:**

    ```bash
    # Build the Docker image
    docker build -t swarm-chat-aggregator .

    # Run the container
    docker run -d \
      --name swarm-chat-aggregator \
      --env-file .env \
      --restart unless-stopped \
      swarm-chat-aggregator
    ```

---

## 💡 Limitations & Potential Improvements

This example serves as a basic illustration. For a more robust, production-ready aggregator, consider the following enhancements:

- **Batch Processing:** Implement batching for writing messages to the chat feed to improve efficiency and reduce the number of individual Swarm operations.
- **Advanced Validation:** Introduce stricter validation rules and schemas for incoming messages to ensure data integrity and security.
- **Message State Size Tuning:** The default 10MB limit for message state references can be adjusted based on your specific use case and network conditions. Consider implementing dynamic sizing or compression strategies.
- **State Consolidation:** Implement periodic consolidation of older message state references to optimize storage and retrieval performance for long-lived conversations.
- **Flexible Feed Logic:** Explore different strategies for organizing chat feeds (e.g., separate feeds per topic, time-based rotation) depending on scale and requirements.
- **Error Handling & Resilience:** Improve error handling, implement retry mechanisms for Swarm operations, and ensure the aggregator can recover from transient network issues.
- **Scalability:** Design for horizontal scalability if anticipating a large number of users or topics.
- **Monitoring & Logging:** Integrate comprehensive logging and monitoring to track the aggregator's health and performance, including message state reference counts and sizes.

---

## 📚 Further Reading

- [What are Feeds? (Official Swarm Documentation)](https://docs.ethswarm.org/docs/develop/tools-and-features/feeds#what-are-feeds)
- [GSOC Introduction (Official Swarm Documentation)](https://docs.ethswarm.org/docs/develop/tools-and-features/gsoc/#introduction)
- [Solar-Punk-Ltd/swarm-chat-js Library](https://github.com/Solar-Punk-Ltd/swarm-chat-js)
