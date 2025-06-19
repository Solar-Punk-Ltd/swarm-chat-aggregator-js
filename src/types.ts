// TODO: types should come from the chat lib

export type TextType = 'text';
export type ThreadType = 'thread';
export type ReactionType = 'reaction';
export type MessageType = TextType | ThreadType | ReactionType;

export interface MessageData {
  id: string;
  targetMessageId?: string;
  type: MessageType;
  message: string;
  username: string;
  address: string;
  timestamp: number;
  signature: string;
  index: number;
  chatTopic: string;
  userTopic: string;
}

export interface StatefulMessage {
  message: MessageData;
  messageStateRefs: MessageStateRef[] | null;
}

export interface MessageStateRef {
  reference: string;
  timestamp: number;
}
