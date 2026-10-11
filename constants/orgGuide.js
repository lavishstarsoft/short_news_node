'use strict';

/**
 * orgGuide.js — SINGLE SOURCE OF TRUTH for the Super Admin "Organization & Access
 * Handbook" content (rendered by views/partials/org-handbook.ejs).
 *
 * FUTURE-PROOFING CONTRACT:
 * When a new Organization feature ships (Departments, Teams, Roles, Staff Directory,
 * Org Chart, Approval Center, RBAC enforcement, Scope enforcement), update:
 *   1. FEATURES: move the item from status 'future' → 'now' (and adjust its note).
 *   2. Any FAQ answers that mention it.
 * Keep language SIMPLE (a non-technical reader must understand it). Do not describe
 * unimplemented behaviour as live. Live runtime facts (e.g. Shadow Mode ON/OFF)
 * must NEVER be hard-coded here — the controller reads them from the real system.
 */

// What exists today vs what is planned. status: 'now' | 'future'
const FEATURES = [
  { name: 'Staff & Users pages', status: 'now', note: 'Existing staff/reporter management (Users, Editors, Reporter Access).' },
  { name: 'News approval workflow', status: 'now', note: 'Reporters submit → Editors/Sub-Editors approve. Unchanged.' },
  { name: 'District-assignment approvals', status: 'now', note: 'State In-Charge proposes → Admin approves.' },
  { name: 'Wallets, earnings & withdrawals', status: 'now', note: 'Existing financial workflows. Unchanged.' },
  { name: 'Audit Logs', status: 'now', note: 'Sensitive actions (finance, roles, impersonation…) are recorded.' },
  { name: 'Permission catalog', status: 'now', note: 'The list of permissions the new system understands (see Authorization page). Reference only — not enforced yet.' },
  { name: 'Shadow Mode (observation)', status: 'now', note: 'Compares new rules with current access on 14 high-risk routes. Never blocks anyone.' },
  { name: 'Departments', status: 'future', note: 'Grouping staff into departments (Editorial, Accounts…).' },
  { name: 'Teams', status: 'future', note: 'Smaller working groups inside a department.' },
  { name: 'Role management', status: 'future', note: 'Create roles, attach permissions, assign staff.' },
  { name: 'Staff Directory (new)', status: 'future', note: 'One searchable directory with filters and profiles.' },
  { name: 'Organization Chart', status: 'future', note: 'Who reports to whom — needs manager data first.' },
  { name: 'Unified Approval Center', status: 'future', note: 'All approvals in one place.' },
  { name: 'Permission enforcement (RBAC)', status: 'future', note: 'The new permission system actually deciding access — only after Shadow Mode proves it is correct.' },
  { name: 'Scope enforcement', status: 'future', note: 'Limiting permissions by state / district / own records.' },
];

// "If I do this → what happens?" — honest, per current implementation.
const ACTIONS = [
  { action: 'Open Shadow Mode page', result: 'You see whether observation is ON/OFF and any disagreements found. Nothing changes for users.', status: 'now' },
  { action: 'Enable Shadow Mode (server setting)', result: 'The system starts observing and comparing on 14 high-risk routes. No user is ever blocked.', status: 'now' },
  { action: 'View Audit Logs', result: 'You see the record of sensitive actions (who, what, when, before/after).', status: 'now' },
  { action: 'Disable a staff member (existing Users page)', result: 'They can no longer log in / work. Their history, audit records and financial records remain.', status: 'now' },
  { action: 'Create a Department', result: 'It will become an organizational group you can place teams and staff under.', status: 'future' },
  { action: 'Create a Team', result: 'It will become a working group under the chosen department.', status: 'future' },
  { action: 'Assign a Role', result: 'The person will receive that role’s permissions once role-based access is implemented.', status: 'future' },
  { action: 'Add / remove a Permission', result: 'The person/role will gain or lose that ability once enforcement is enabled.', status: 'future' },
];

// Super Admin Golden Rules (recommendations, not enforced by software today).
const GOLDEN_RULES = [
  'Give people only the access they need — nothing extra.',
  'Do not give global access unless truly necessary.',
  'Do not create duplicate departments or near-identical roles.',
  'Review sensitive (especially financial) permissions regularly.',
  'Never share Super Admin credentials with anyone.',
  'Check Audit Logs after sensitive changes.',
  'Test a change on one person before applying it broadly.',
  'Disable access promptly when staff leave, per company policy.',
  'Never change financial permissions casually.',
  'When unsure — observe first (Shadow Mode), enforce later.',
];

// FAQ — simple questions & answers.
const FAQ = [
  { q: 'What is a Department?', a: 'A big group of staff doing the same kind of work — like Editorial or Accounts. (Planned — coming in a future phase.)' },
  { q: 'What is a Team?', a: 'A smaller working group inside a department — like a "Payments Team" inside Accounts. (Planned.)' },
  { q: 'What is a Role?', a: 'The kind of job a person does — Editor, Reporter, Accounts Manager. A role decides what work they are responsible for.' },
  { q: 'What is a Permission?', a: 'One single ability — like "can approve news" or "can view payments".' },
  { q: 'What is Scope?', a: 'WHERE a permission works — own records only, one district, one state, or everywhere (global).' },
  { q: 'Can one person have multiple responsibilities?', a: 'Yes — in the future role system a person can hold more than one role if needed. Keep it minimal.' },
  { q: 'What happens if I disable a staff member?', a: 'They stop being able to log in and work. Their history, audit and financial records are kept — nothing is deleted.' },
  { q: 'Can I give someone global access?', a: 'You can, but you should not unless it is truly required. Global access means access to everything — treat it like a master key.' },
  { q: 'What is Shadow Mode?', a: 'A safety test: the new permission system watches and compares in the background. It never blocks anyone.' },
  { q: 'Does Shadow Mode block users?', a: 'No. Never. It only observes and records disagreements for you to review.' },
  { q: 'What is Authorization?', a: '"What are you allowed to do?" — different from Authentication, which is "who are you?" (login).' },
  { q: 'What is Audit?', a: 'A trustworthy record of important actions: who did what, when, and what changed.' },
  { q: 'Can I delete a staff member?', a: 'The existing Users page allows deletion, but disabling is safer — it preserves history. Delete only when policy requires it.' },
  { q: 'What should I do before changing permissions?', a: 'Understand what the permission allows, change one person first, verify, and then check the Audit Log afterwards.' },
];

module.exports = { FEATURES, ACTIONS, GOLDEN_RULES, FAQ };
