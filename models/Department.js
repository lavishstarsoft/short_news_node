const mongoose = require('mongoose');

/**
 * Department — ORGANIZATIONAL GROUPING ONLY (Phase A: schema only).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ SECURITY INVARIANT: membership in a department grants ZERO permissions.  │
 * │ This model is NOT connected to authentication/authorization and must     │
 * │ never be read by the permission resolver as a grant.                     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Lifecycle: departments are DISABLED (status:'inactive'), never hard-deleted,
 * because staff documents and future audit records may reference them.
 * Phase A creates the schema only — no production departments are seeded.
 */
const departmentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
      unique: true
    },
    // Short immutable identifier (e.g. 'EDIT', 'ACCT'). Uppercased for consistency.
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 12,
      unique: true,
      immutable: true
    },
    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500
    },
    // One accountable head (an Admin/staff member). Organizational pointer only.
    headId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      index: true
    },
    sortOrder: {
      type: Number,
      default: 0
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Department', departmentSchema);
