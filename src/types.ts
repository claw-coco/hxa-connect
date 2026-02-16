// ─── Core Entities ───────────────────────────────────────────

export interface Org {
  id: string;
  name: string;
  api_key: string;
  admin_secret: string;
  persist_messages: boolean;
  created_at: number;
}

export interface Agent {
  id: string;
  org_id: string;
  name: string;
  display_name: string | null;
  token: string;
  metadata: string | null; // JSON string
  webhook_url: string | null;
  webhook_secret: string | null;
  bio: string | null;
  role: string | null;
  function: string | null;
  team: string | null;
  tags: string | null; // JSON string of string[]
  languages: string | null; // JSON string of string[]
  protocols: string | null; // JSON string
  status_text: string | null;
  timezone: string | null;
  active_hours: string | null;
  version: string;
  runtime: string | null;
  online: boolean;
  last_seen_at: number | null;
  created_at: number;
}

export interface Channel {
  id: string;
  org_id: string;
  type: 'direct' | 'group';
  name: string | null;
  created_at: number;
}

export interface ChannelMember {
  channel_id: string;
  agent_id: string;
  joined_at: number;
}

export interface Message {
  id: string;
  channel_id: string;
  sender_id: string;
  content: string;
  content_type: 'text' | 'json' | 'system';
  created_at: number;
}

// ─── API Request/Response Types ──────────────────────────────

export interface BotProtocols {
  version: string;
  messaging: boolean;
  threads: boolean;
  streaming: boolean;
}

export interface AgentProfileInput {
  bio?: string | null;
  role?: string | null;
  function?: string | null;
  team?: string | null;
  tags?: string[] | null;
  languages?: string[] | null;
  protocols?: BotProtocols | null;
  status_text?: string | null;
  timezone?: string | null;
  active_hours?: string | null;
  version?: string;
  runtime?: string | null;
}

export interface RegisterRequest {
  name: string;
  display_name?: string;
  bio?: string | null;
  role?: string | null;
  function?: string | null;
  team?: string | null;
  tags?: string[] | null;
  languages?: string[] | null;
  protocols?: BotProtocols | null;
  status_text?: string | null;
  timezone?: string | null;
  active_hours?: string | null;
  version?: string;
  runtime?: string | null;
  metadata?: Record<string, unknown>;
  webhook_url?: string;
  webhook_secret?: string; // Sent as Authorization: Bearer <secret>
}

export interface RegisterResponse {
  agent_id: string;
  token: string;
  name: string;
}

export interface UpdateProfileRequest extends AgentProfileInput {}

export interface ListBotsFilters {
  role?: string;
  tag?: string;
  status?: string;
  q?: string;
}

export interface CreateChannelRequest {
  type: 'direct' | 'group';
  name?: string;
  members: string[]; // agent IDs or names
}

export interface SendMessageRequest {
  content: string;
  content_type?: 'text' | 'json';
}

export interface DirectSendRequest {
  to: string; // agent ID or name
  content: string;
  content_type?: 'text' | 'json';
}

// ─── WebSocket Events ────────────────────────────────────────

export type WsServerEvent =
  | { type: 'message'; channel_id: string; message: Message; sender_name: string }
  | { type: 'agent_online'; agent: Pick<Agent, 'id' | 'name' | 'display_name'> }
  | { type: 'agent_offline'; agent: Pick<Agent, 'id' | 'name' | 'display_name'> }
  | { type: 'channel_created'; channel: Channel; members: string[] }
  | { type: 'error'; message: string }
  | { type: 'pong' };

export type WsClientEvent =
  | { type: 'send'; channel_id: string; content: string; content_type?: string }
  | { type: 'ping' };

// ─── Config ──────────────────────────────────────────────────

export interface HubConfig {
  port: number;
  host: string;
  data_dir: string;
  default_persist: boolean;
  cors_origins: string[];
  max_message_length: number;
  log_level: 'debug' | 'info' | 'warn' | 'error';
  admin_secret?: string;
}

export const DEFAULT_CONFIG: HubConfig = {
  port: 4800,
  host: '0.0.0.0',
  data_dir: './data',
  default_persist: true,
  cors_origins: ['*'],
  max_message_length: 65536,
  log_level: 'info',
  admin_secret: undefined,
};
