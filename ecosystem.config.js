module.exports = {
  apps: [
    {
      name: 'swarm-chat-agg',
      script: 'dist/index.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        GSOC_BEE_URL: process.env.GSOC_BEE_URL,
        GSOC_RESOURCE_ID: process.env.GSOC_RESOURCE_ID,
        GSOC_TOPIC: process.env.GSOC_TOPIC,
        CHAT_BEE_URL: process.env.CHAT_BEE_URL,
        CHAT_KEY: process.env.CHAT_KEY,
        CHAT_STAMP: process.env.CHAT_STAMP,
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '32G',
      time: true,
    },
  ],
};
