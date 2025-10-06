import { MessageData, MessageStateRef } from '@solarpunkltd/swarm-chat-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProtoMessage } from '../src/waku/ProtoMessage';

vi.mock('protobufjs', () => ({
  default: {
    load: vi.fn().mockResolvedValue({
      resolveAll: vi.fn(),
      lookupType: vi.fn().mockReturnValue({
        create: vi.fn((data) => data),
        encode: vi.fn().mockReturnValue({
          finish: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4])),
        }),
      }),
    }),
  },
  load: vi.fn().mockResolvedValue({
    resolveAll: vi.fn(),
    lookupType: vi.fn().mockReturnValue({
      create: vi.fn((data) => data),
      encode: vi.fn().mockReturnValue({
        finish: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4])),
      }),
    }),
  }),
}));

vi.mock('../src/waku/Waku', () => {
  const mockWakuInstance = {
    init: vi.fn().mockResolvedValue(undefined),
    createWakuEncoder: vi.fn().mockReturnValue({
      contentTopic: 'test-topic',
      ephemeral: true,
    }),
    publishMessage: vi.fn().mockResolvedValue(undefined),
    getNode: vi.fn().mockReturnValue({
      isStarted: true,
    }),
  };

  return {
    Waku: {
      getInstance: vi.fn().mockReturnValue(mockWakuInstance),
    },
  };
});

vi.mock('../src/libs/logger', () => ({
  Logger: {
    getInstance: vi.fn().mockReturnValue({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

describe('ProtoMessage', () => {
  const testStreamTopic = 'test-topic';

  let protoMessage: ProtoMessage;

  const mockMessageData: MessageData = {
    id: 'test-message-id-123',
    targetMessageId: 'target-message-id-456',
    type: 'text' as any,
    message: 'Hello, this is a test message!',
    username: 'testuser',
    address: '0x1234567890abcdef1234567890abcdef12345678',
    timestamp: 1695384000000,
    signature: 'test-signature-hash',
    index: 1,
    chatTopic: 'general-chat',
    userTopic: 'user-topic-123',
  };

  const mockMessageStateRefs: MessageStateRef[] = [
    {
      reference: 'ref-hash-1',
      timestamp: 1695384000000,
    },
    {
      reference: 'ref-hash-2',
      timestamp: 1695384060000,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    protoMessage = new ProtoMessage(testStreamTopic);
  });

  describe('constructor', () => {
    it('should create a ProtoMessage instance', () => {
      expect(protoMessage).toBeInstanceOf(ProtoMessage);
    });

    it('should accept streamTopic parameter', () => {
      const instance = new ProtoMessage('test-topic');
      expect(instance).toBeInstanceOf(ProtoMessage);
    });
  });

  describe('init', () => {
    it('should initialize without errors', async () => {
      await expect(protoMessage.init()).resolves.not.toThrow();
    });

    it('should throw error if protobuf loading fails', async () => {
      const instance = new ProtoMessage(testStreamTopic);
      await expect(instance.init()).resolves.not.toThrow();
    });
  });

  describe('publishMessageUpdate', () => {
    it('should throw error if not initialized', async () => {
      await expect(protoMessage.publishMessageUpdate(mockMessageData, mockMessageStateRefs)).rejects.toThrow(
        'WakuPublish not initialized',
      );
    });

    it('should publish message with refs after initialization', async () => {
      await protoMessage.init();

      await expect(protoMessage.publishMessageUpdate(mockMessageData, mockMessageStateRefs)).resolves.not.toThrow();
    });

    it('should handle empty refs array', async () => {
      await protoMessage.init();

      await expect(protoMessage.publishMessageUpdate(mockMessageData, [])).resolves.not.toThrow();
    });

    it('should handle single ref', async () => {
      await protoMessage.init();
      const singleRef = [mockMessageStateRefs[0]];

      await expect(protoMessage.publishMessageUpdate(mockMessageData, singleRef)).resolves.not.toThrow();
    });

    it('should handle different message types', async () => {
      await protoMessage.init();

      const threadMessage: MessageData = {
        ...mockMessageData,
        type: 'thread' as any,
      };

      const reactionMessage: MessageData = {
        ...mockMessageData,
        type: 'reaction' as any,
      };

      await expect(protoMessage.publishMessageUpdate(threadMessage, mockMessageStateRefs)).resolves.not.toThrow();

      await expect(protoMessage.publishMessageUpdate(reactionMessage, mockMessageStateRefs)).resolves.not.toThrow();
    });

    it('should handle optional fields correctly', async () => {
      await protoMessage.init();

      const messageWithoutTarget: MessageData = {
        ...mockMessageData,
        targetMessageId: undefined,
      };

      await expect(
        protoMessage.publishMessageUpdate(messageWithoutTarget, mockMessageStateRefs),
      ).resolves.not.toThrow();
    });
  });
});
