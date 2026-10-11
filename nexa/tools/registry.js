'use strict';

/**
 * TEHELKA NEXA — Tool Registry.
 *
 * NEXA can ONLY act through registered tools. The LLM never sees the database
 * and never generates queries — it can only ask to run a named tool with typed
 * input. Every tool enforces: input validation, RBAC, autonomy level, optional
 * rate limit, audit logging, and safe error handling.
 *
 * A tool definition:
 *   {
 *     name: 'getPendingTasks',
 *     description: '...',
 *     autonomyLevel: 0,                  // required level (see autonomy.js)
 *     readOnly: true,                    // does it change data?
 *     permission: 'view_pending' | null, // RBAC permission required (null = any authed)
 *     validate(input) -> {ok, value|error},
 *     handler(input, ctx) -> Promise<result>
 *   }
 */

const { config } = require('../config');
const autonomy = require('../autonomy');
const audit = require('../audit');

const _tools = new Map();

function register(tool) {
  if (!tool || !tool.name || typeof tool.handler !== 'function') {
    throw new Error('[NEXA] invalid tool registration');
  }
  if (_tools.has(tool.name)) {
    throw new Error(`[NEXA] tool already registered: ${tool.name}`);
  }
  _tools.set(tool.name, {
    autonomyLevel: 0,
    readOnly: true,
    permission: null,
    validate: () => ({ ok: true, value: undefined }),
    ...tool,
  });
  return tool.name;
}

function list() {
  return [..._tools.values()].map((t) => ({
    name: t.name,
    description: t.description || '',
    autonomyLevel: t.autonomyLevel,
    readOnly: !!t.readOnly,
    permission: t.permission || null,
  }));
}

/** Does the caller's role/permissions satisfy the tool's RBAC requirement? */
function _hasPermission(tool, ctx) {
  if (!tool.permission) return true; // any authenticated actor
  const role = ctx && ctx.role;
  if (role === 'superadmin' || role === 'admin') return true; // full access
  const perms = (ctx && ctx.permissions) || {};
  return perms[tool.permission] === true;
}

/**
 * Run a registered tool. ALWAYS safe: returns {ok:false,...} instead of throwing.
 * @param {string} name
 * @param {object} input
 * @param {object} ctx  { role, permissions, actorId, actorName, workflow }
 */
async function run(name, input = {}, ctx = {}) {
  const started = Date.now();
  const tool = _tools.get(name);
  if (!tool) {
    return { ok: false, error: 'unknown_tool' };
  }

  // NEXA must be active for tools to run at all.
  if (!config.isActive()) {
    return { ok: false, error: 'nexa_inactive' };
  }

  // RBAC
  if (!_hasPermission(tool, ctx)) {
    await audit.record({
      workflow: ctx.workflow || 'tool',
      action: name,
      status: 'skipped',
      mode: 'blocked',
      reason: 'permission_denied',
    });
    return { ok: false, error: 'permission_denied' };
  }

  // Input validation
  let value = input;
  try {
    const v = tool.validate(input);
    if (!v || v.ok !== true) {
      return { ok: false, error: 'invalid_input', detail: v && v.error };
    }
    if (v.value !== undefined) value = v.value;
  } catch (e) {
    return { ok: false, error: 'validation_threw', detail: e && e.message };
  }

  // Autonomy gate for WRITE tools (read-only tools skip execution gating).
  if (!tool.readOnly) {
    const gate = autonomy.evaluate({
      action: name,
      autonomyLevel: tool.autonomyLevel,
      confidence: ctx.confidence,
      category: tool.category,
    });
    if (!gate.execute) {
      await audit.record({
        workflow: ctx.workflow || 'tool',
        action: name,
        status: gate.requiresApproval ? 'awaiting_approval' : 'skipped',
        mode: gate.mode,
        autonomyLevel: tool.autonomyLevel,
        requiresApproval: gate.requiresApproval,
        reason: gate.reason,
        aiDecision: value,
      });
      return { ok: false, error: 'not_permitted_by_autonomy', gate };
    }
  }

  // Execute
  try {
    const result = await tool.handler(value, ctx);
    if (!tool.readOnly) {
      await audit.record({
        workflow: ctx.workflow || 'tool',
        action: name,
        status: 'completed',
        mode: 'live',
        autonomyLevel: tool.autonomyLevel,
        reason: 'executed',
        durationMs: Date.now() - started,
      });
    }
    return { ok: true, result };
  } catch (e) {
    await audit.record({
      workflow: ctx.workflow || 'tool',
      action: name,
      status: 'failed',
      mode: tool.readOnly ? 'shadow' : 'live',
      error: e && e.message,
      durationMs: Date.now() - started,
    });
    return { ok: false, error: 'tool_failed', detail: e && e.message };
  }
}

module.exports = { register, run, list, _tools };
