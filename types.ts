export enum AppMode {
  TextChat = 'TEXT_CHAT',
  LiveConversation = 'LIVE_CONVERSATION',
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

export interface Transcript {
  id: string;
  text: string;
  source: 'user' | 'model' | 'user_interim' | 'model_interim';
}