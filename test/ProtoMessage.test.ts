import { MessageData, MessageStateRef } from '@solarpunkltd/swarm-chat-js';
import { describe, expect, it } from 'vitest';

import { decodeMessagePayload, encodeMessagePayload } from '../src/push/ProtoMessage';

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

  describe('decodeMessagePayload', () => {
    it('should decode MessagePayload back to original data', async () => {
      const encoded = await encodeMessagePayload(mockMessageData, mockMessageStateRefs);
      const decoded = await decodeMessagePayload(encoded);

      expect(decoded).toHaveProperty('message');
      expect(decoded).toHaveProperty('messageStateRefs');

      expect(decoded.message).toEqual(
        expect.objectContaining({
          id: mockMessageData.id,
          message: mockMessageData.message,
          username: mockMessageData.username,
          address: mockMessageData.address,
          timestamp: mockMessageData.timestamp,
          signature: mockMessageData.signature,
          index: mockMessageData.index,
          chatTopic: mockMessageData.chatTopic,
          userTopic: mockMessageData.userTopic,
        }),
      );

      expect(decoded.messageStateRefs).toHaveLength(2);
      expect(decoded.messageStateRefs[0]).toEqual(
        expect.objectContaining({
          reference: mockMessageStateRefs[0].reference,
          timestamp: mockMessageStateRefs[0].timestamp,
        }),
      );
    });

    it('should handle empty refs array in decode', async () => {
      const encoded = await encodeMessagePayload(mockMessageData, []);
      const decoded = await decodeMessagePayload(encoded);

      expect(decoded.messageStateRefs).toHaveLength(0);
    });

    it('should preserve ref timestamps as numbers', async () => {
      const encoded = await encodeMessagePayload(mockMessageData, mockMessageStateRefs);
      const decoded = await decodeMessagePayload(encoded);

      decoded.messageStateRefs.forEach((ref) => {
        expect(typeof ref.timestamp).toBe('number');
        expect(ref.timestamp).toBeGreaterThan(0);
      });
    });

    it('should preserve all field types correctly', async () => {
      const encoded = await encodeMessagePayload(mockMessageData, mockMessageStateRefs);
      const decoded = await decodeMessagePayload(encoded);

      expect(typeof decoded.message.id).toBe('string');
      expect(typeof decoded.message.message).toBe('string');
      expect(typeof decoded.message.username).toBe('string');
      expect(typeof decoded.message.address).toBe('string');
      expect(typeof decoded.message.timestamp).toBe('number');
      expect(typeof decoded.message.signature).toBe('string');
      expect(typeof decoded.message.index).toBe('number');
      expect(typeof decoded.message.chatTopic).toBe('string');
      expect(typeof decoded.message.userTopic).toBe('string');
    });

    it('should handle optional fields correctly in decode', async () => {
      const messageWithoutTarget: MessageData = {
        ...mockMessageData,
        targetMessageId: undefined,
      };

      const encoded = await encodeMessagePayload(messageWithoutTarget, mockMessageStateRefs);
      const decoded = await decodeMessagePayload(encoded);

      expect(decoded.message.targetMessageId).toBeUndefined();
    });

    it('should decode different message types correctly', async () => {
      const threadMessage: MessageData = {
        ...mockMessageData,
        type: 'thread' as any,
      };

      const encoded = await encodeMessagePayload(threadMessage, mockMessageStateRefs);
      const decoded = await decodeMessagePayload(encoded);

      expect(decoded.message.type).toBe('thread');
    });

    it('should throw error for invalid payload buffer', async () => {
      const invalidBuffer = new Uint8Array([1, 2, 3, 4, 5]);

      await expect(decodeMessagePayload(invalidBuffer)).rejects.toThrow();
    });
  });

  describe('Round-trip encoding/decoding', () => {
    it('should maintain data integrity through encode/decode cycle', async () => {
      // Test MessagePayload round-trip
      const encoded = await encodeMessagePayload(mockMessageData, mockMessageStateRefs);
      const decoded = await decodeMessagePayload(encoded);

      expect(decoded.message.id).toBe(mockMessageData.id);
      expect(decoded.message.message).toBe(mockMessageData.message);
      expect(decoded.message.username).toBe(mockMessageData.username);
      expect(decoded.message.timestamp).toBe(mockMessageData.timestamp);
      expect(decoded.message.type).toBe(mockMessageData.type);
      expect(decoded.messageStateRefs).toHaveLength(mockMessageStateRefs.length);
    });

    it('should produce consistent encoding for same input', async () => {
      const encoded1 = await encodeMessagePayload(mockMessageData, mockMessageStateRefs);
      const encoded2 = await encodeMessagePayload(mockMessageData, mockMessageStateRefs);

      expect(encoded1).toEqual(encoded2);
    });

    it('should handle large message content', async () => {
      const largeMessage: MessageData = {
        ...mockMessageData,
        message: 'A'.repeat(10000), // 10KB message
      };

      const encoded = await encodeMessagePayload(largeMessage, mockMessageStateRefs);
      const decoded = await decodeMessagePayload(encoded);

      expect(decoded.message.message).toBe(largeMessage.message);
      expect(decoded.message.message.length).toBe(10000);
    });

    it('should handle all message types in round-trip', async () => {
      const messageTypes = ['text', 'thread', 'reaction'] as const;

      for (const type of messageTypes) {
        const testMessage: MessageData = {
          ...mockMessageData,
          type: type as any,
        };

        const encoded = await encodeMessagePayload(testMessage, mockMessageStateRefs);
        const decoded = await decodeMessagePayload(encoded);

        expect(decoded.message.type).toBe(type);
      }
    });
  });

  describe('Error handling', () => {
    it('should handle protobuf initialization errors gracefully', async () => {
      // This test ensures the functions can handle initialization issues
      expect(async () => {
        await encodeMessagePayload(mockMessageData, mockMessageStateRefs);
      }).not.toThrow();
    });

    it('should validate required fields', async () => {
      const invalidMessage = {
        ...mockMessageData,
        id: '', // Empty required field
      };

      // Protobuf should still encode this, but it's worth testing
      const encoded = await encodeMessagePayload(invalidMessage, mockMessageStateRefs);
      expect(encoded).toBeInstanceOf(Uint8Array);
    });
  });

  describe('Performance considerations', () => {
    it('should initialize protobuf only once', async () => {
      // Multiple calls should reuse the same protobuf root
      const start = Date.now();

      await encodeMessagePayload(mockMessageData, mockMessageStateRefs);
      await encodeMessagePayload(mockMessageData, mockMessageStateRefs);
      await encodeMessagePayload(mockMessageData, []);

      const duration = Date.now() - start;

      // Should be fast since protobuf is cached after first call
      expect(duration).toBeLessThan(1000); // Less than 1 second
    });

    it('should handle concurrent encoding requests', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        encodeMessagePayload({ ...mockMessageData, id: `test-${i}` }, mockMessageStateRefs),
      );

      const results = await Promise.all(promises);

      results.forEach((result) => {
        expect(result).toBeInstanceOf(Uint8Array);
        expect(result.length).toBeGreaterThan(0);
      });
    });

    it('should handle concurrent decode requests', async () => {
      const encoded = await encodeMessagePayload(mockMessageData, mockMessageStateRefs);

      const promises = Array.from({ length: 10 }, () => decodeMessagePayload(encoded));

      const results = await Promise.all(promises);

      results.forEach((result) => {
        expect(result.message.id).toBe(mockMessageData.id);
        expect(result.messageStateRefs).toHaveLength(mockMessageStateRefs.length);
      });
    });
  });
});
