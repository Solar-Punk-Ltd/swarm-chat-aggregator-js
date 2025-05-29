# Swarm Chat JS: Example GSOC Aggregator Server 🐝💬

This project provides an example implementation of a GSOC aggregator server designed to work with the [Solar-Punk-Ltd/swarm-chat-js](https://github.com/Solar-Punk-Ltd/swarm-chat-js) library.

The primary function of this server is to receive messages sent by chat users via a public GSOC feed and consolidate them into a more persistent, access-controlled Swarm feed (the "chat feed"). This aggregator can manage multiple chat topics under a single GSOC node.

**Note:** This is an example implementation. For production environments, consider enhancing aspects like batch processing, message validation, schema enforcement, and feed writing policies.

---

## ⚙️ How It Works

The aggregator server operates through the following steps:

1.  **GSOC Subscription:** The server connects to a specified Bee node (`GSOC_BEE_URL`) and subscribes to updates on a particular GSOC resource (`GSOC_RESOURCE_ID`) and topic (`GSOC_TOPIC`). This GSOC feed is where chat users publish their messages.
2.  **Message Reception:** As new messages arrive on the GSOC feed, the server receives them.
3.  **Message Processing:** The server expects incoming messages to contain a `chatTopic` field (e.g., `parsed.chatTopic`), indicating the specific chat room or topic the message belongs to. This allows the aggregator to handle multiple distinct chat conversations.
4.  **Chat Feed Writing:** Valid messages are then written to a separate, designated Swarm feed (the "chat feed"). This feed is managed by a different Bee node (`CHAT_BEE_URL`) and secured with a private key (`CHAT_KEY`), ensuring that only authorized entities (like this aggregator) can write to it. All messages across various topics (handled by this aggregator instance) are consolidated into this single chat feed. Writes to this feed require a valid postage stamp (`CHAT_STAMP`).

This setup allows for a public message submission mechanism via GSOC, with a backend aggregator ensuring messages are collected and stored reliably on a more controlled Swarm feed.

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
    pnpm/npm build
    ```
5.  **Start the server:**
    ```bash
    npm start
    # or
    yarn start
    ```

---

## 💡 Limitations & Potential Improvements

This example serves as a basic illustration. For a more robust, production-ready aggregator, consider the following enhancements:

- **Batch Processing:** Implement batching for writing messages to the chat feed to improve efficiency and reduce the number of individual Swarm operations.
- **Advanced Validation:** Introduce stricter validation rules and schemas for incoming messages to ensure data integrity and security.
- **Flexible Feed Logic:** Explore different strategies for organizing chat feeds (e.g., separate feeds per topic, time-based rotation) depending on scale and requirements.
- **Error Handling & Resilience:** Improve error handling, implement retry mechanisms for Swarm operations, and ensure the aggregator can recover from transient network issues.
- **Scalability:** Design for horizontal scalability if anticipating a large number of users or topics.
- **Monitoring & Logging:** Integrate comprehensive logging and monitoring to track the aggregator's health and performance.

---

## 📚 Further Reading

- [What are Feeds? (Official Swarm Documentation)](https://docs.ethswarm.org/docs/develop/tools-and-features/feeds#what-are-feeds)
- [GSOC Introduction (Official Swarm Documentation)](https://docs.ethswarm.org/docs/develop/tools-and-features/gsoc/#introduction)
- [Solar-Punk-Ltd/swarm-chat-js Library](https://github.com/Solar-Punk-Ltd/swarm-chat-js)

---
