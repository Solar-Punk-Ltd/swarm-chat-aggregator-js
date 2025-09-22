import { MessageData, MessageStateRef } from '@solarpunkltd/swarm-chat-js';
import { describe, expect, it } from 'vitest';

import { encodeMessagePayload } from '../src/push/ProtoMessage';

describe('ProtoMessage', () => {
  // Test data
  const mockMessageData: MessageData = {
    id: 'test-message-id-123',
    targetMessageId: 'target-message-id-456',
    type: 'text' as any, // MessageType.TEXT
    message: 'Hello, this is a test message!',
    username: 'testuser',
    address: '0x1234567890abcdef1234567890abcdef12345678',
    timestamp: 1695384000000, // Sept 22, 2023
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

  describe('encodeMessagePayload', () => {
    it('should encode MessagePayload with message and refs', async () => {
      const encoded = await encodeMessagePayload(mockMessageData, mockMessageStateRefs);

      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(encoded.length).toBeGreaterThan(0);
    });

    it('should handle empty refs array', async () => {
      const encoded = await encodeMessagePayload(mockMessageData, []);

      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(encoded.length).toBeGreaterThan(0);
    });

    it('should handle single ref', async () => {
      const singleRef = [mockMessageStateRefs[0]];
      const encoded = await encodeMessagePayload(mockMessageData, singleRef);

      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(encoded.length).toBeGreaterThan(0);
    });

    it('should handle different message types', async () => {
      const threadMessage: MessageData = {
        ...mockMessageData,
        type: 'thread' as any, // MessageType.THREAD
      };

      const reactionMessage: MessageData = {
        ...mockMessageData,
        type: 'reaction' as any, // MessageType.REACTION
      };

      const threadEncoded = await encodeMessagePayload(threadMessage, mockMessageStateRefs);
      const reactionEncoded = await encodeMessagePayload(reactionMessage, mockMessageStateRefs);

      expect(threadEncoded).toBeInstanceOf(Uint8Array);
      expect(reactionEncoded).toBeInstanceOf(Uint8Array);
      expect(threadEncoded).not.toEqual(reactionEncoded);
    });

    it('should handle optional fields correctly', async () => {
      const messageWithoutTarget: MessageData = {
        ...mockMessageData,
        targetMessageId: undefined,
      };

      const encoded = await encodeMessagePayload(messageWithoutTarget, mockMessageStateRefs);

      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(encoded.length).toBeGreaterThan(0);
    });
  });
});
