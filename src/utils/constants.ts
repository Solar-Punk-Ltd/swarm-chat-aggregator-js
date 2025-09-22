export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const WAKU_CONTENT_TOPIC = 'solarpunk-msrs/1/push/proto';
export const WAKU_CLUSTER_ID = 1;
export const WAKU_SHARD_ID = 0;
// The pubsub topic format is `/waku/2/rs/{clusterId}/{shardId}`.
// See: https://github.com/waku-org/js-waku/blob/master/packages/utils/src/common/sharding/topics.ts
export const WAKU_PUB_SUB_TOPIC = `/waku/2/rs/${WAKU_CLUSTER_ID}/${WAKU_SHARD_ID}`;
