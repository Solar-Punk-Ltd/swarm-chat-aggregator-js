import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';

import { WAKU_CLUSTER_ID } from '../src/utils/constants';
import { Waku } from '../src/waku/Waku';

describe('Waku - createWakuEncoder', () => {
  const waku = Waku.getInstance();

  describe('shardId calculation', () => {
    it('should calculate shardId correctly from topic name hash', () => {
      const topicName = 'general-chat';
      const encoder = waku.createWakuEncoder(topicName);

      // Calculate expected shardId using the same algorithm
      const hash = createHash('sha256').update(topicName).digest('hex');
      const NUM_SHARDS = 8;
      const hashInt = BigInt('0x' + hash);
      const expectedShardId = Number(hashInt % BigInt(NUM_SHARDS));

      // Verify the encoder has the correct routing info
      expect(encoder.routingInfo?.shardId).toBe(expectedShardId);
      expect(encoder.routingInfo?.clusterId).toBe(WAKU_CLUSTER_ID);
      expect(encoder.routingInfo?.pubsubTopic).toBe(`/waku/2/rs/${WAKU_CLUSTER_ID}/${expectedShardId}`);
    });

    it('should produce shardId between 0 and 7 (inclusive)', () => {
      const testTopics = [
        'general-chat',
        'random-topic',
        'test-123',
        'very-long-topic-name-with-special-chars-!@#$%',
        'short',
        '🚀emoji-topic',
        'UPPERCASE-TOPIC',
        'topic.with.dots',
      ];

      testTopics.forEach((topicName) => {
        const encoder = waku.createWakuEncoder(topicName);
        const shardId = encoder.routingInfo?.shardId;

        expect(shardId).toBeGreaterThanOrEqual(0);
        expect(shardId).toBeLessThanOrEqual(7);
        expect(Number.isInteger(shardId)).toBe(true);
      });
    });

    it('should produce consistent shardId for the same topic', () => {
      const topicName = 'consistent-topic';

      const encoder1 = waku.createWakuEncoder(topicName);
      const encoder2 = waku.createWakuEncoder(topicName);
      const encoder3 = waku.createWakuEncoder(topicName);

      expect(encoder1.routingInfo?.shardId).toBe(encoder2.routingInfo?.shardId);
      expect(encoder2.routingInfo?.shardId).toBe(encoder3.routingInfo?.shardId);
    });

    it('should produce different shardIds for different topics (distribution test)', () => {
      const topics = Array.from({ length: 50 }, (_, i) => `topic-${i}`);
      const shardIds = topics.map((topic) => waku.createWakuEncoder(topic).routingInfo?.shardId);

      // Check that we get some variety in shardIds (not all the same)
      const uniqueShardIds = new Set(shardIds);
      expect(uniqueShardIds.size).toBeGreaterThan(1);

      // Verify all shardIds are valid
      shardIds.forEach((shardId) => {
        expect(shardId).toBeGreaterThanOrEqual(0);
        expect(shardId).toBeLessThanOrEqual(7);
      });
    });

    it('should handle edge cases correctly', () => {
      const edgeCases = [
        '', // empty string
        ' ', // single space
        '\n\t', // whitespace characters
        '0', // single digit
        'a'.repeat(1000), // very long string
      ];

      edgeCases.forEach((topicName) => {
        const encoder = waku.createWakuEncoder(topicName);
        const shardId = encoder.routingInfo?.shardId;

        expect(shardId).toBeGreaterThanOrEqual(0);
        expect(shardId).toBeLessThanOrEqual(7);
        expect(Number.isInteger(shardId)).toBe(true);
      });
    });
  });

  describe('encoder configuration', () => {
    it('should set correct contentTopic format', () => {
      const topicName = 'test-topic';
      const encoder = waku.createWakuEncoder(topicName);

      expect(encoder.contentTopic).toBe(`solarpunk-msrs/1/${topicName}/proto`);
    });

    it('should set ephemeral to true', () => {
      const encoder = waku.createWakuEncoder('test-topic');
      expect(encoder.ephemeral).toBe(true);
    });

    it('should set correct pubsubTopic format', () => {
      const topicName = 'test-topic';
      const encoder = waku.createWakuEncoder(topicName);

      const expectedShardId = encoder.routingInfo?.shardId;
      expect(encoder.routingInfo?.pubsubTopic).toBe(`/waku/2/rs/${WAKU_CLUSTER_ID}/${expectedShardId}`);
    });

    it('should set correct clusterId', () => {
      const encoder = waku.createWakuEncoder('test-topic');
      expect(encoder.routingInfo?.clusterId).toBe(WAKU_CLUSTER_ID);
    });
  });

  describe('hash-based sharding verification', () => {
    it('should verify specific known hash calculations', () => {
      // Test with known inputs to verify the hash-to-shard calculation
      const testCases = [
        {
          topic: 'general-chat',
          expectedHash: createHash('sha256').update('general-chat').digest('hex'),
        },
        {
          topic: 'dev-team',
          expectedHash: createHash('sha256').update('dev-team').digest('hex'),
        },
      ];

      testCases.forEach(({ topic, expectedHash }) => {
        const encoder = waku.createWakuEncoder(topic);

        // Verify our calculation matches the implementation
        const hashInt = BigInt('0x' + expectedHash);
        const expectedShardId = Number(hashInt % BigInt(8));

        expect(encoder.routingInfo?.shardId).toBe(expectedShardId);
      });
    });

    it('should handle BigInt overflow correctly', () => {
      // Test with a topic that might produce a very large hash
      const largeHashTopic = 'topic-that-produces-large-hash-value-for-testing-bigint-handling';
      const encoder = waku.createWakuEncoder(largeHashTopic);

      // Should still produce valid shardId despite large hash
      const shardId = encoder.routingInfo?.shardId;
      expect(shardId).toBeGreaterThanOrEqual(0);
      expect(shardId).toBeLessThanOrEqual(7);
    });
  });
});
