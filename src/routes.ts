import { Router } from 'express';
import type { HubDB } from './db.js';
import type { HubWS } from './ws.js';
import { authMiddleware, requireAgent, requireOrg } from './auth.js';
import type { HubConfig, Agent, AgentProfileInput, Thread, ThreadStatus, ThreadType, CloseReason, ArtifactType } from './types.js';

function parseJsonField<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function toAgentResponse(agent: Agent) {
  return {
    id: agent.id,
    org_id: agent.org_id,
    name: agent.name,
    display_name: agent.display_name,
    online: agent.online,
    last_seen_at: agent.last_seen_at,
    created_at: agent.created_at,
    metadata: parseJsonField<Record<string, unknown>>(agent.metadata),
    bio: agent.bio,
    role: agent.role,
    function: agent.function,
    team: agent.team,
    tags: parseJsonField<string[]>(agent.tags),
    languages: parseJsonField<string[]>(agent.languages),
    protocols: parseJsonField<Record<string, unknown>>(agent.protocols),
    status_text: agent.status_text,
    timezone: agent.timezone,
    active_hours: agent.active_hours,
    version: agent.version,
    runtime: agent.runtime,
  };
}

function getQueryString(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}

const THREAD_TYPES = new Set<ThreadType>(['discussion', 'request', 'collab']);
const THREAD_STATUSES = new Set<ThreadStatus>(['open', 'active', 'blocked', 'reviewing', 'resolved', 'closed']);
const CLOSE_REASONS = new Set<CloseReason>(['manual', 'timeout', 'error']);
const ARTIFACT_TYPES = new Set<ArtifactType>(['text', 'markdown', 'json', 'code', 'file', 'link']);
const ARTIFACT_KEY_PATTERN = /^[A-Za-z0-9._~-]+$/;

export function createRouter(db: HubDB, ws: HubWS, config: HubConfig): Router {
  const router = Router();

  // ─── Public: Setup ────────────────────────────────────────

  // Admin secret check helper
  function requireAdmin(req: import('express').Request, res: import('express').Response): boolean {
    if (!config.admin_secret) return true; // No secret = open (local/dev mode)
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    if (token !== config.admin_secret) {
      res.status(401).json({ error: 'Admin authentication required' });
      return false;
    }
    return true;
  }

  function requireOrgOrAgent(req: import('express').Request, res: import('express').Response): string | undefined {
    if (req.agent) return req.agent.org_id;
    if (req.org) return req.org.id;
    res.status(403).json({ error: 'Authentication required' });
    return undefined;
  }

  function resolveAgent(orgId: string, idOrName: unknown): Agent | undefined {
    if (typeof idOrName !== 'string') return undefined;
    const bot = db.getAgentById(idOrName) || db.getAgentByName(orgId, idOrName);
    if (!bot || bot.org_id !== orgId) return undefined;
    return bot;
  }

  function requireThreadParticipant(
    req: import('express').Request,
    res: import('express').Response,
    threadId: string,
  ): Thread | undefined {
    const thread = db.getThread(threadId);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return undefined;
    }

    if (!req.agent || !db.isParticipant(thread.id, req.agent.id)) {
      res.status(403).json({ error: 'Not a participant of this thread' });
      return undefined;
    }

    return thread;
  }

  /**
   * POST /api/orgs — Create an organization
   * Body: { name, persist_messages? }
   * Auth: Admin secret (if BOTSHUB_ADMIN_SECRET is set)
   * Returns: org with api_key
   */
  router.post('/api/orgs', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { name, persist_messages } = req.body;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const org = db.createOrg(name, persist_messages ?? config.default_persist);
    res.json(org);
  });

  /**
   * GET /api/orgs — List all orgs
   * Auth: Admin secret (if BOTSHUB_ADMIN_SECRET is set)
   */
  router.get('/api/orgs', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(db.listOrgs());
  });

  // ─── Authenticated Routes ─────────────────────────────────

  const auth = Router();
  auth.use(authMiddleware(db));

  /**
   * POST /api/register — Register an agent
   * Auth: Org API key
   * Body: { name, display_name?, metadata? }
   * Returns: { agent_id, token, name }
   */
  auth.post('/api/register', requireOrg, (req, res) => {
    const {
      name,
      display_name,
      metadata,
      webhook_url,
      webhook_secret,
      bio,
      role,
      function: functionName,
      team,
      tags,
      languages,
      protocols,
      status_text,
      timezone,
      active_hours,
      version,
      runtime,
    } = req.body;

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      res.status(400).json({ error: 'name must be alphanumeric (a-z, 0-9, _, -)' });
      return;
    }

    const profile: AgentProfileInput = {
      bio,
      role,
      function: functionName,
      team,
      tags,
      languages,
      protocols,
      status_text,
      timezone,
      active_hours,
      version,
      runtime,
    };

    const agent = db.registerAgent(req.org!.id, name, display_name, metadata, webhook_url, webhook_secret, profile);

    // Broadcast agent online to all org viewers (Web UI etc.)
    ws.broadcastToOrg(req.org!.id, {
      type: 'agent_online',
      agent: { id: agent.id, name: agent.name, display_name: agent.display_name },
    });

    res.json({
      agent_id: agent.id,
      token: agent.token,
      ...toAgentResponse(agent),
    });
  });

  /**
   * GET /api/agents — List agents in the org
   */
  auth.get('/api/agents', requireOrg, (req, res) => {
    const agents = db.listAgents(req.org!.id);
    res.json(agents.map(a => toAgentResponse(a)));
  });

  /**
   * DELETE /api/agents/:id — Remove an agent (org admin only)
   * Auth: Org API Key + Org Admin Secret (via X-Admin-Secret header)
   */
  auth.delete('/api/agents/:id', requireOrg, (req, res) => {
    // Require org admin secret
    const adminSecret = req.headers['x-admin-secret'] as string;
    if (!adminSecret || !db.verifyOrgAdminSecret(req.org!.id, adminSecret)) {
      res.status(403).json({ error: 'Org admin secret required' });
      return;
    }

    const agent = db.getAgentById(req.params.id as string);
    if (!agent || agent.org_id !== req.org!.id) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    db.deleteAgent(agent.id);

    // Broadcast agent offline
    ws.broadcastToOrg(agent.org_id, {
      type: 'agent_offline',
      agent: { id: agent.id, name: agent.name, display_name: agent.display_name },
    });

    res.json({ ok: true, message: `Agent "${agent.name}" deleted` });
  });

  /**
   * DELETE /api/me — Deregister self (agent unregisters itself)
   * Auth: Agent token
   */
  auth.delete('/api/me', requireAgent, (req, res) => {
    const agent = req.agent!;
    db.deleteAgent(agent.id);

    // Broadcast agent offline
    ws.broadcastToOrg(agent.org_id, {
      type: 'agent_offline',
      agent: { id: agent.id, name: agent.name, display_name: agent.display_name },
    });

    res.json({ ok: true, message: `Agent "${agent.name}" deregistered` });
  });

  /**
   * GET /api/me — Get current agent info
   */
  auth.get('/api/me', requireAgent, (req, res) => {
    const a = req.agent!;
    res.json(toAgentResponse(a));
  });

  /**
   * PATCH /api/me/profile — Update current bot profile fields
   */
  auth.patch('/api/me/profile', requireAgent, (req, res) => {
    const {
      bio,
      role,
      function: functionName,
      team,
      tags,
      languages,
      protocols,
      status_text,
      timezone,
      active_hours,
      version,
      runtime,
    } = req.body;

    const fields: AgentProfileInput = {
      bio,
      role,
      function: functionName,
      team,
      tags,
      languages,
      protocols,
      status_text,
      timezone,
      active_hours,
      version,
      runtime,
    };

    if (Object.values(fields).every(v => v === undefined)) {
      res.status(400).json({ error: 'No profile fields provided' });
      return;
    }

    const updated = db.updateProfile(req.agent!.id, fields);
    if (!updated) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    req.agent = updated;
    res.json(toAgentResponse(updated));
  });

  /**
   * GET /api/peers — List other agents in my org (from agent perspective)
   */
  auth.get('/api/peers', requireAgent, (req, res) => {
    const agents = db.listAgents(req.agent!.org_id);
    res.json(agents
      .filter(a => a.id !== req.agent!.id)
      .map(a => toAgentResponse(a))
    );
  });

  /**
   * GET /api/bots — Discover bots in org
   * Query: role?, tag?, status?, q?
   * Auth: org API key or agent token
   */
  auth.get('/api/bots', (req, res) => {
    const orgId = requireOrgOrAgent(req, res);
    if (!orgId) return;

    const role = getQueryString(req.query.role);
    const tag = getQueryString(req.query.tag);
    const status = getQueryString(req.query.status);
    const q = getQueryString(req.query.q);

    const bots = db.listBots(orgId, { role, tag, status, q });
    res.json(bots.map(bot => toAgentResponse(bot)));
  });

  /**
   * GET /api/bots/:name/profile — Get full profile by bot name
   * Auth: org API key or agent token
   */
  auth.get('/api/bots/:name/profile', (req, res) => {
    const orgId = requireOrgOrAgent(req, res);
    if (!orgId) return;

    const bot = db.getAgentByName(orgId, req.params.name as string);
    if (!bot) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }

    res.json(toAgentResponse(bot));
  });

  // ─── Channels ─────────────────────────────────────────────

  /**
   * POST /api/channels — Create a channel
   * Body: { type: 'direct'|'group', members: [agent_id_or_name, ...], name? }
   */
  auth.post('/api/channels', requireOrg, (req, res) => {
    const { type, members, name } = req.body;
    const orgId = req.org!.id;

    if (!type || !members || !Array.isArray(members) || members.length < 2) {
      res.status(400).json({ error: 'type and members (≥2) are required' });
      return;
    }

    // Resolve member names to IDs
    const memberIds: string[] = [];
    for (const m of members) {
      const agent = db.getAgentById(m) || db.getAgentByName(orgId, m);
      if (!agent || agent.org_id !== orgId) {
        res.status(400).json({ error: `Agent not found: ${m}` });
        return;
      }
      memberIds.push(agent.id);
    }

    const channel = db.createChannel(orgId, type, memberIds, name);

    // Broadcast channel creation
    ws.broadcastToOrg(orgId, {
      type: 'channel_created',
      channel,
      members: memberIds,
    });

    res.json({ ...channel, members: memberIds });
  });

  /**
   * GET /api/channels — List channels
   * For agents: channels they're in
   * For org admins: all channels
   */
  auth.get('/api/channels', (req, res) => {
    if (req.agent) {
      res.json(db.listChannelsForAgent(req.agent.id));
    } else if (req.org) {
      res.json(db.listChannelsForOrg(req.org.id));
    } else {
      res.status(403).json({ error: 'Authentication required' });
    }
  });

  /**
   * GET /api/channels/:id — Get channel details
   */
  auth.get('/api/channels/:id', (req, res) => {
    const channel = db.getChannel(req.params.id as string);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    // Check access
    if (req.agent && !db.isChannelMember(channel.id, req.agent.id)) {
      res.status(403).json({ error: 'Not a member of this channel' });
      return;
    }
    if (req.org && channel.org_id !== req.org.id) {
      res.status(403).json({ error: 'Channel not in your org' });
      return;
    }

    const members = db.getChannelMembers(channel.id).map(m => {
      const agent = db.getAgentById(m.agent_id);
      return {
        id: m.agent_id,
        name: agent?.name,
        display_name: agent?.display_name,
        online: agent?.online,
      };
    });

    res.json({ ...channel, members });
  });

  /**
   * POST /api/channels/:id/join — Join a group channel (agent)
   */
  auth.post('/api/channels/:id/join', requireAgent, (req, res) => {
    const channel = db.getChannel(req.params.id as string);
    if (!channel || channel.type !== 'group') {
      res.status(404).json({ error: 'Group channel not found' });
      return;
    }
    if (channel.org_id !== req.agent!.org_id) {
      res.status(403).json({ error: 'Channel not in your org' });
      return;
    }
    db.addChannelMember(channel.id, req.agent!.id);
    res.json({ ok: true });
  });

  /**
   * DELETE /api/channels/:id — Delete a channel (org admin only)
   * Auth: Org API Key + X-Admin-Secret
   */
  auth.delete('/api/channels/:id', requireOrg, (req, res) => {
    const adminSecret = req.headers['x-admin-secret'] as string;
    if (!adminSecret || !db.verifyOrgAdminSecret(req.org!.id, adminSecret)) {
      res.status(403).json({ error: 'Org admin secret required' });
      return;
    }

    const channel = db.getChannel(req.params.id as string);
    if (!channel || channel.org_id !== req.org!.id) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    db.deleteChannel(channel.id);

    // Broadcast channel deletion
    ws.broadcastToOrg(req.org!.id, {
      type: 'channel_deleted' as any,
      channel_id: channel.id,
    });

    res.json({ ok: true, message: `Channel deleted` });
  });

  // ─── Threads ─────────────────────────────────────────────

  /**
   * POST /api/threads — Create a thread
   * Body: { topic, type?, participants?, channel_id?, context? }
   */
  auth.post('/api/threads', requireAgent, (req, res) => {
    const { topic, type, participants, channel_id, context } = req.body;
    const orgId = req.agent!.org_id;

    if (!topic || typeof topic !== 'string') {
      res.status(400).json({ error: 'topic is required' });
      return;
    }

    const threadType = (typeof type === 'string' ? type : 'discussion') as ThreadType;
    if (!THREAD_TYPES.has(threadType)) {
      res.status(400).json({ error: 'Invalid thread type' });
      return;
    }

    if (participants !== undefined && !Array.isArray(participants)) {
      res.status(400).json({ error: 'participants must be an array' });
      return;
    }

    const resolvedParticipantIds: string[] = [];
    for (const p of (participants || [])) {
      const bot = resolveAgent(orgId, p);
      if (!bot) {
        res.status(400).json({ error: `Agent not found: ${p}` });
        return;
      }
      resolvedParticipantIds.push(bot.id);
    }

    let resolvedChannelId: string | undefined;
    if (channel_id !== undefined && channel_id !== null) {
      if (typeof channel_id !== 'string') {
        res.status(400).json({ error: 'channel_id must be a string' });
        return;
      }

      const channel = db.getChannel(channel_id);
      if (!channel || channel.org_id !== orgId) {
        res.status(400).json({ error: 'Invalid channel_id' });
        return;
      }
      resolvedChannelId = channel.id;
    }

    let contextJson: string | null | undefined;
    if (context !== undefined) {
      if (context === null) {
        contextJson = null;
      } else if (typeof context === 'string') {
        contextJson = context;
      } else {
        try {
          contextJson = JSON.stringify(context);
        } catch {
          res.status(400).json({ error: 'context must be JSON-serializable' });
          return;
        }
      }
    }

    try {
      const thread = db.createThread(
        orgId,
        req.agent!.id,
        topic,
        threadType,
        resolvedParticipantIds,
        resolvedChannelId,
        contextJson,
      );

      ws.broadcastThreadEvent(orgId, thread.id, {
        type: 'thread_created',
        thread,
      });

      res.json(thread);
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Failed to create thread' });
    }
  });

  /**
   * GET /api/threads — List my threads
   * Query: status?
   */
  auth.get('/api/threads', requireAgent, (req, res) => {
    const statusRaw = getQueryString(req.query.status);
    if (statusRaw && !THREAD_STATUSES.has(statusRaw as ThreadStatus)) {
      res.status(400).json({ error: 'Invalid status filter' });
      return;
    }

    const status = statusRaw as ThreadStatus | undefined;
    const threads = db.listThreadsForAgent(req.agent!.id, status);
    res.json(threads);
  });

  /**
   * GET /api/threads/:id — Thread details with participants
   */
  auth.get('/api/threads/:id', requireAgent, (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    const participants = db.getParticipants(thread.id).map(p => {
      const bot = db.getAgentById(p.bot_id);
      return {
        bot_id: p.bot_id,
        name: bot?.name,
        display_name: bot?.display_name,
        online: bot?.online,
        label: p.label,
        joined_at: p.joined_at,
      };
    });

    res.json({ ...thread, participants });
  });

  /**
   * PATCH /api/threads/:id — Update thread status/context
   * Body: { status?, close_reason?, context? }
   */
  auth.patch('/api/threads/:id', requireAgent, (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    const { status: statusInput, close_reason, context } = req.body;
    if (statusInput === undefined && context === undefined && close_reason === undefined) {
      res.status(400).json({ error: 'No updatable fields provided' });
      return;
    }

    let status: ThreadStatus | undefined;
    if (statusInput !== undefined) {
      if (typeof statusInput !== 'string' || !THREAD_STATUSES.has(statusInput as ThreadStatus)) {
        res.status(400).json({ error: 'Invalid status' });
        return;
      }
      status = statusInput as ThreadStatus;
    }

    let closeReason: CloseReason | undefined;
    if (close_reason !== undefined) {
      if (typeof close_reason !== 'string' || !CLOSE_REASONS.has(close_reason as CloseReason)) {
        res.status(400).json({ error: 'Invalid close_reason' });
        return;
      }
      closeReason = close_reason as CloseReason;
    }

    if (status === 'closed' && closeReason === undefined) {
      res.status(400).json({ error: 'close_reason is required for closed status' });
      return;
    }
    if (status !== 'closed' && closeReason !== undefined) {
      res.status(400).json({ error: 'close_reason is only allowed with closed status' });
      return;
    }

    let contextJson: string | null | undefined;
    if (context !== undefined) {
      if (context === null) {
        contextJson = null;
      } else if (typeof context === 'string') {
        contextJson = context;
      } else {
        try {
          contextJson = JSON.stringify(context);
        } catch {
          res.status(400).json({ error: 'context must be JSON-serializable' });
          return;
        }
      }
    }

    const changes: string[] = [];
    let updated: Thread | undefined = thread;

    try {
      if (status !== undefined) {
        updated = db.updateThreadStatus(thread.id, status, closeReason);
        if (!updated) {
          res.status(404).json({ error: 'Thread not found' });
          return;
        }
        changes.push('status');
        if (status === 'closed') changes.push('close_reason');
        if (status === 'resolved') changes.push('resolved_at');
      }

      if (context !== undefined) {
        updated = db.updateThreadContext(thread.id, contextJson ?? null);
        if (!updated) {
          res.status(404).json({ error: 'Thread not found' });
          return;
        }
        changes.push('context');
      }
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Failed to update thread' });
      return;
    }

    ws.broadcastThreadEvent(thread.org_id, thread.id, {
      type: 'thread_updated',
      thread: updated!,
      changes,
    });

    res.json(updated);
  });

  /**
   * POST /api/threads/:id/participants — Invite bot (id or name)
   * Body: { bot_id, label? }
   */
  auth.post('/api/threads/:id/participants', requireAgent, (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    const { bot_id, label } = req.body;
    if (!bot_id || typeof bot_id !== 'string') {
      res.status(400).json({ error: 'bot_id is required' });
      return;
    }
    if (label !== undefined && label !== null && typeof label !== 'string') {
      res.status(400).json({ error: 'label must be a string' });
      return;
    }

    const bot = resolveAgent(thread.org_id, bot_id);
    if (!bot) {
      res.status(404).json({ error: `Agent not found: ${bot_id}` });
      return;
    }

    const alreadyParticipant = db.isParticipant(thread.id, bot.id);
    try {
      const participant = db.addParticipant(thread.id, bot.id, label);

      if (!alreadyParticipant) {
        ws.broadcastThreadEvent(thread.org_id, thread.id, {
          type: 'thread_participant',
          thread_id: thread.id,
          bot_id: bot.id,
          action: 'joined',
        });
      }

      res.json(participant);
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Failed to add participant' });
    }
  });

  /**
   * DELETE /api/threads/:id/participants/:bot — Leave/remove participant (id or name)
   */
  auth.delete('/api/threads/:id/participants/:bot', requireAgent, (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    const target = resolveAgent(thread.org_id, req.params.bot as string);
    if (!target) {
      res.status(404).json({ error: `Agent not found: ${req.params.bot}` });
      return;
    }

    if (!db.isParticipant(thread.id, target.id)) {
      res.status(404).json({ error: 'Bot is not a participant in this thread' });
      return;
    }

    const participants = db.getParticipants(thread.id);
    if (participants.length <= 1) {
      res.status(400).json({ error: 'Cannot remove the last participant from a thread' });
      return;
    }

    db.removeParticipant(thread.id, target.id);
    ws.broadcastThreadEvent(thread.org_id, thread.id, {
      type: 'thread_participant',
      thread_id: thread.id,
      bot_id: target.id,
      action: 'left',
    });

    res.json({ ok: true });
  });

  /**
   * POST /api/threads/:id/messages — Send a thread message
   * Body: { content, content_type?, metadata? }
   */
  auth.post('/api/threads/:id/messages', requireAgent, (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    const { content, content_type, metadata } = req.body;
    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    if (content.length > config.max_message_length) {
      res.status(400).json({ error: `Message too long (max ${config.max_message_length} chars)` });
      return;
    }

    let metadataJson: string | null | undefined;
    if (metadata !== undefined) {
      if (metadata === null) {
        metadataJson = null;
      } else if (typeof metadata === 'string') {
        metadataJson = metadata;
      } else {
        try {
          metadataJson = JSON.stringify(metadata);
        } catch {
          res.status(400).json({ error: 'metadata must be JSON-serializable' });
          return;
        }
      }
    }

    const message = db.createThreadMessage(
      thread.id,
      req.agent!.id,
      content,
      typeof content_type === 'string' ? content_type : 'text',
      metadataJson,
    );

    ws.broadcastThreadEvent(thread.org_id, thread.id, {
      type: 'thread_message',
      thread_id: thread.id,
      message,
    });

    res.json(message);
  });

  /**
   * GET /api/threads/:id/messages — Get thread messages
   * Query: limit?, before?
   */
  auth.get('/api/threads/:id/messages', requireAgent, (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    const limit = Math.min(parseInt(getQueryString(req.query.limit) || '') || 50, 200);
    const beforeStr = getQueryString(req.query.before);
    const before = beforeStr ? parseInt(beforeStr) : undefined;

    const messages = db.getThreadMessages(thread.id, limit, before);
    const enriched = messages.map(m => {
      const sender = db.getAgentById(m.sender_id);
      return { ...m, sender_name: sender?.name || 'unknown' };
    });

    res.json(enriched.reverse());
  });

  /**
   * POST /api/threads/:id/artifacts — Add artifact (new key or new version)
   */
  auth.post('/api/threads/:id/artifacts', requireAgent, (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    const {
      artifact_key,
      type,
      title,
      content,
      language,
      url,
      mime_type,
    } = req.body;

    if (!artifact_key || typeof artifact_key !== 'string' || !ARTIFACT_KEY_PATTERN.test(artifact_key)) {
      res.status(400).json({ error: 'artifact_key is required and must be URL-safe' });
      return;
    }

    const artifactType = (typeof type === 'string' ? type : 'text') as ArtifactType;
    if (!ARTIFACT_TYPES.has(artifactType)) {
      res.status(400).json({ error: 'Invalid artifact type' });
      return;
    }

    if (title !== undefined && title !== null && typeof title !== 'string') {
      res.status(400).json({ error: 'title must be a string or null' });
      return;
    }
    if (content !== undefined && content !== null && typeof content !== 'string') {
      res.status(400).json({ error: 'content must be a string or null' });
      return;
    }
    if (language !== undefined && language !== null && typeof language !== 'string') {
      res.status(400).json({ error: 'language must be a string or null' });
      return;
    }
    if (url !== undefined && url !== null && typeof url !== 'string') {
      res.status(400).json({ error: 'url must be a string or null' });
      return;
    }
    if (mime_type !== undefined && mime_type !== null && typeof mime_type !== 'string') {
      res.status(400).json({ error: 'mime_type must be a string or null' });
      return;
    }

    try {
      const artifact = db.addArtifact(
        thread.id,
        req.agent!.id,
        artifact_key,
        artifactType,
        title === undefined ? undefined : (title ?? null),
        content === undefined ? undefined : (content ?? null),
        language === undefined ? undefined : (language ?? null),
        url === undefined ? undefined : (url ?? null),
        mime_type === undefined ? undefined : (mime_type ?? null),
      );

      ws.broadcastThreadEvent(thread.org_id, thread.id, {
        type: 'thread_artifact',
        thread_id: thread.id,
        artifact,
        action: 'added',
      });

      res.json(artifact);
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Failed to add artifact' });
    }
  });

  /**
   * PATCH /api/threads/:id/artifacts/:key — Update artifact (new version)
   */
  auth.patch('/api/threads/:id/artifacts/:key', requireAgent, (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    const key = req.params.key as string;
    if (!key || !ARTIFACT_KEY_PATTERN.test(key)) {
      res.status(400).json({ error: 'Invalid artifact key' });
      return;
    }

    const { content, title } = req.body;
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content is required' });
      return;
    }
    if (title !== undefined && title !== null && typeof title !== 'string') {
      res.status(400).json({ error: 'title must be a string or null' });
      return;
    }

    try {
      const artifact = db.updateArtifact(
        thread.id,
        key,
        req.agent!.id,
        content,
        title === undefined ? undefined : (title ?? null),
      );

      if (!artifact) {
        res.status(404).json({ error: 'Artifact not found' });
        return;
      }

      ws.broadcastThreadEvent(thread.org_id, thread.id, {
        type: 'thread_artifact',
        thread_id: thread.id,
        artifact,
        action: 'updated',
      });

      res.json(artifact);
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Failed to update artifact' });
    }
  });

  /**
   * GET /api/threads/:id/artifacts — List latest artifact version for each key
   */
  auth.get('/api/threads/:id/artifacts', requireAgent, (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    res.json(db.listArtifacts(thread.id));
  });

  /**
   * GET /api/threads/:id/artifacts/:key/versions — List all versions for a key
   */
  auth.get('/api/threads/:id/artifacts/:key/versions', requireAgent, (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    const key = req.params.key as string;
    if (!key || !ARTIFACT_KEY_PATTERN.test(key)) {
      res.status(400).json({ error: 'Invalid artifact key' });
      return;
    }

    res.json(db.getArtifactVersions(thread.id, key));
  });

  // ─── Messages ─────────────────────────────────────────────

  /**
   * POST /api/channels/:id/messages — Send a message to a channel
   * Body: { content, content_type? }
   */
  auth.post('/api/channels/:id/messages', requireAgent, (req, res) => {
    const channel = db.getChannel(req.params.id as string);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    if (!db.isChannelMember(channel.id, req.agent!.id)) {
      res.status(403).json({ error: 'Not a member of this channel' });
      return;
    }

    const { content, content_type } = req.body;
    if (!content) {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    if (content.length > config.max_message_length) {
      res.status(400).json({ error: `Message too long (max ${config.max_message_length} chars)` });
      return;
    }

    const msg = db.createMessage(channel.id, req.agent!.id, content, content_type || 'text');

    // Broadcast via WebSocket
    ws.broadcastMessage(channel.id, msg, req.agent!.name);

    res.json(msg);
  });

  /**
   * GET /api/channels/:id/messages — Get messages from a channel
   * Query: limit?, before? (timestamp)
   */
  auth.get('/api/channels/:id/messages', (req, res) => {
    const channel = db.getChannel(req.params.id as string);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    // Check access
    if (req.agent && !db.isChannelMember(channel.id, req.agent.id)) {
      res.status(403).json({ error: 'Not a member of this channel' });
      return;
    }
    if (req.org && channel.org_id !== req.org.id) {
      res.status(403).json({ error: 'Channel not in your org' });
      return;
    }

    const limit = Math.min(parseInt(getQueryString(req.query.limit) || '') || 50, 200);
    const beforeStr = getQueryString(req.query.before);
    const before = beforeStr ? parseInt(beforeStr) : undefined;

    const messages = db.getMessages(channel.id, limit, before);

    // Enrich with sender names
    const enriched = messages.map(m => {
      const sender = db.getAgentById(m.sender_id);
      return { ...m, sender_name: sender?.name || 'unknown' };
    });

    res.json(enriched.reverse()); // Return in chronological order
  });

  /**
   * POST /api/send — Quick send: DM an agent by name/id (auto-creates channel)
   * Body: { to, content, content_type? }
   */
  auth.post('/api/send', requireAgent, (req, res) => {
    const { to, content, content_type } = req.body;
    if (!to || !content) {
      res.status(400).json({ error: 'to and content are required' });
      return;
    }

    const orgId = req.agent!.org_id;
    const target = db.getAgentById(to) || db.getAgentByName(orgId, to);

    if (!target || target.org_id !== orgId) {
      res.status(404).json({ error: `Agent not found: ${to}` });
      return;
    }

    if (target.id === req.agent!.id) {
      res.status(400).json({ error: 'Cannot send to yourself' });
      return;
    }

    if (content.length > config.max_message_length) {
      res.status(400).json({ error: `Message too long (max ${config.max_message_length} chars)` });
      return;
    }

    // Find or create direct channel
    const channel = db.createChannel(orgId, 'direct', [req.agent!.id, target.id]);

    // Broadcast channel creation if new
    if (channel.isNew) {
      ws.broadcastToOrg(orgId, {
        type: 'channel_created',
        channel: { id: channel.id, org_id: channel.org_id, type: channel.type, name: channel.name, created_at: channel.created_at },
        members: [req.agent!.id, target.id],
      });
    }

    const msg = db.createMessage(channel.id, req.agent!.id, content, content_type || 'text');

    // Broadcast
    ws.broadcastMessage(channel.id, msg, req.agent!.name);

    res.json({ channel_id: channel.id, message: msg });
  });

  /**
   * GET /api/inbox — Get new messages since timestamp
   * Query: since (timestamp, required)
   */
  auth.get('/api/inbox', requireAgent, (req, res) => {
    const since = parseInt(getQueryString(req.query.since) || '');
    if (isNaN(since)) {
      res.status(400).json({ error: 'since (timestamp) is required' });
      return;
    }

    const messages = db.getNewMessages(req.agent!.id, since);
    const enriched = messages.map(m => {
      const sender = db.getAgentById(m.sender_id);
      return { ...m, sender_name: sender?.name || 'unknown' };
    });

    res.json(enriched);
  });

  // Mount authenticated routes
  router.use(auth);

  return router;
}
