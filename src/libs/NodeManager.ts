import axios, { AxiosInstance } from 'axios';

import { ErrorHandler } from './error.js';

export enum NodeType {
  MEDIA = 'media',
  CHAT = 'chat',
}

interface NodeInfo {
  port: string;
  hash: string;
  locked: boolean;
  lock_info?: {
    locked_at: number;
    locked_by: string;
    instance: string;
    stream_id: string;
    type: NodeType;
    pinned: boolean;
  };
}

interface StatusResponse {
  nodes: {
    private_writers: NodeInfo[];
    public_writers: NodeInfo[];
    readers: any[];
  };
  summary: {
    total_private_writers: number;
    locked_private_writers: number;
    pinned_private_writers: number;
    available_private_writers: number;
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

  public async getRequiredChatNode(streamId: string): Promise<NodeInfo | null> {
    try {
      const response = await this.axios.get('/admin/node/status');
      const statusData: StatusResponse = response.data;

      for (const node of statusData.nodes.private_writers) {
        if (node.locked && node.lock_info?.stream_id === streamId && node.lock_info?.type === NodeType.CHAT) {
          return node;
        }
      }

      return null;
    } catch (error) {
      this.errorHandler.handleError(error, 'NodeManager.getRequiredChatNode');
      return null;
    }
  }
}
