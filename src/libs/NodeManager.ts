import axios, { AxiosInstance } from 'axios';

import { ErrorHandler } from './error.js';

export enum NodeType {
  MEDIA = 'media',
  CHAT = 'chat',
}

interface StampInfo {
  stamp: string;
  state: string;
  lock_info?: {
    locked_at: number;
    locked_by: string;
    stream_id: string;
    type: NodeType;
    pinned: boolean;
  };
  history?: {
    stream_id: string;
    type: NodeType;
    unlocked_at: number;
    locked_at: number;
    locked_by: string;
    pinned: boolean;
  };
}

interface PrivateWriterNode {
  port: string;
  total_stamps: number;
  stamps: StampInfo[];
}

interface CustomPrivateWriterNode {
  port: string;
  stamps: Array<{
    stamp: string;
    tags: string[];
  }>;
}

interface PublicWriterNode {
  port: string;
  hash: string;
}

interface ReaderNode {
  status: string;
  port: number;
}

interface StatusResponse {
  instance: string;
  timestamp: number;
  persistence: {
    exists: boolean;
    modified: number;
    path: string;
  };
  nodes: {
    private_writers: PrivateWriterNode[];
    custom_private_writers: CustomPrivateWriterNode[];
    public_writers: PublicWriterNode[];
    readers: ReaderNode[];
  };
  summary: {
    stamps: {
      total: number;
      locked: number;
      locked_pinned: number;
      history_unpinned: number;
      history_pinned: number;
      free: number;
    };
  };
}

export class NodeManager {
  private axios: AxiosInstance;
  private errorHandler = ErrorHandler.getInstance();

  constructor(private gatewayUrl: string, private adminSecret: string) {
    this.axios = axios.create({
      baseURL: this.gatewayUrl,
      headers: {
        'X-MSRS-Admin-Token': this.adminSecret,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });
  }

  public async getRequiredChatNode(streamId: string): Promise<{ port: string; stamp: string } | null> {
    try {
      const response = await this.axios.get('/admin/node/status');
      const statusData: StatusResponse = response.data;

      for (const node of statusData.nodes.private_writers) {
        for (const stamp of node.stamps) {
          if (stamp.history?.stream_id === streamId && stamp.history?.type === NodeType.CHAT) {
            return { port: node.port, stamp: stamp.stamp };
          }
        }
      }

      return null;
    } catch (error) {
      this.errorHandler.handleError(error, 'NodeManager.getRequiredChatNode');
      return null;
    }
  }

  public async getCustomNodeWithTags(requiredTags: string[]): Promise<{ port: string; stamp: string } | null> {
    try {
      const response = await this.axios.get('/admin/node/status');
      const statusData: StatusResponse = response.data;

      for (const node of statusData.nodes.custom_private_writers) {
        for (const stampInfo of node.stamps) {
          const hasAllTags = requiredTags.every((tag) => stampInfo.tags.includes(tag));
          if (hasAllTags) {
            return { port: node.port, stamp: stampInfo.stamp };
          }
        }
      }

      return null;
    } catch (error) {
      this.errorHandler.handleError(error, 'NodeManager.getCustomNodeWithTags');
      return null;
    }
  }
}
