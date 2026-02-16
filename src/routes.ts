import { Router } from 'express';
import type { HubDB } from './db.js';
import type { HubWS } from './ws.js';
import { authMiddleware, requireAgent, requireOrg } from './auth.js';
import type { HubConfig, Agent, AgentProfileInput } from './types.js';

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
