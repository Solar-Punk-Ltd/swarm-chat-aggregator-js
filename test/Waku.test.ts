import { createRoutingInfo } from '@waku/utils';
import { describe, expect, it } from 'vitest';

import { WAKU_CLUSTER_ID } from '../src/utils/constants';
import { Waku } from '../src/waku/Waku';

describe('Waku - createWakuEncoder', () => {
  const waku = Waku.getInstance();

  describe('shardId calculation', () => {
    it('should calculate shardId correctly from topic name hash', () => {
      const topicName = 'general-chat';
      const encoder = waku.createWakuEncoder(topicName);

      // Calculate expected shardId using the same algorithm as implementation
      const networkConfig = {
        clusterId: WAKU_CLUSTER_ID,
        numShardsInCluster: 8,
      };
      const contentTopic = `/solarpunk-msrs/1/${topicName}/proto`;
      const expectedRoutingInfo = createRoutingInfo(networkConfig, { contentTopic });

      // Verify the encoder has the correct routing info
      expect(encoder.routingInfo?.shardId).toBe(expectedRoutingInfo.shardId);
      expect(encoder.routingInfo?.clusterId).toBe(WAKU_CLUSTER_ID);
      expect(encoder.routingInfo?.pubsubTopic).toBe(expectedRoutingInfo.pubsubTopic);
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

    it('should produce deterministic shardIds for topics', () => {
      // Test that the sharding is deterministic and within valid range
      const topics = ['general-chat', 'development-team', 'random-discussions', 'announcements', 'support-help'];

      const shardIds = topics.map((topic) => waku.createWakuEncoder(topic).routingInfo?.shardId);

      // Verify all shardIds are valid (this is the main requirement)
      shardIds.forEach((shardId, index) => {
        expect(shardId).toBeGreaterThanOrEqual(0);
        expect(shardId).toBeLessThanOrEqual(7);
        expect(Number.isInteger(shardId)).toBe(true);

        // Verify deterministic behavior - same topic should always produce same shardId
        const secondEncoder = waku.createWakuEncoder(topics[index]);
        expect(secondEncoder.routingInfo?.shardId).toBe(shardId);
      });
    });

    it('should handle edge cases correctly', () => {
      const edgeCases = [
        'x', // single character
        '0', // single digit
        'topic-with-dashes',
        'topic_with_underscores',
        'TopicWithCaps',
        'a'.repeat(100), // long string (but reasonable)
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

      expect(encoder.contentTopic).toBe(`/solarpunk-msrs/1/${topicName}/proto`);
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
      // Test with known inputs to verify they use the correct routing algorithm
      const testCases = ['general-chat', 'dev-team'];

      testCases.forEach((topic) => {
        const encoder = waku.createWakuEncoder(topic);

        // Verify it produces a valid shardId using the createRoutingInfo function
        const networkConfig = {
          clusterId: WAKU_CLUSTER_ID,
          numShardsInCluster: 8,
        };
        const contentTopic = `/solarpunk-msrs/1/${topic}/proto`;
        const expectedRoutingInfo = createRoutingInfo(networkConfig, { contentTopic });

        expect(encoder.routingInfo?.shardId).toBe(expectedRoutingInfo.shardId);
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
