const mongoose = require('mongoose');
const { ALL_PERMISSIONS } = require('../constants/permissions');

/**
 * Role — a reusable RESPONSIBILITY definition (Phase A: schema only).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ This does NOT replace Admin.role. Admin.role (admin/superadmin/editor/   │
 * │ subeditor) remains the authoritative coarse authentication tier. This    │
 * │ Role entity is future RBAC metadata: it is read by NOTHING until the     │
 * │ separately-approved shadow-validation phase, and enforced by nothing     │
 * │ until an explicitly-approved enforcement phase.                          │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * permissions[] values MUST come from the existing catalog
 * (constants/permissions.js) — validated at schema level.
 * Roles are disabled, never hard-deleted; isSystem roles are seeded/protected.
 */
const roleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
      unique: true
    },
    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500
    },
    // null = organization-wide role (e.g. Super Admin); otherwise scoped to a department.
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      default: null,
      index: true
    },
    permissions: {
      type: [String],
      default: [],
      validate: {
        validator: (arr) => (arr || []).every((p) => ALL_PERMISSIONS.includes(p)),
        message: 'permissions[] contains a code not present in constants/permissions.js'
      }
    },
    // The default breadth this role's permissions apply at (descriptive metadata
    // in Phase A; evaluated only by the future enforcement layer).
    defaultScopeType: {
      type: String,
      enum: ['global', 'state', 'district', 'reporters', 'managed', 'own'],
      default: 'own'
    },
    // Seeded/system roles (e.g. Super Admin, Reporter) — protected from deletion.
    isSystem: {
      type: Boolean,
      default: false
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      index: true
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Role', roleSchema);
