const mongoose = require('mongoose');

/**
 * Team — a smaller working group INSIDE a department (Phase A: schema only).
 *
 * Rules (from the approved Phase-4 architecture):
 *  - A team CANNOT exist without a department (departmentId required).
 *  - Team membership grants ZERO permissions — organizational grouping only.
 *  - Teams are disabled (status:'inactive'), never hard-deleted.
 *  - Optional: teams are only expected once a department grows (~15+ people);
 *    Phase A seeds nothing.
 */
const teamSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80
    },
    code: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 12,
      default: ''
    },
    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500
    },
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      required: true,
      index: true
    },
    // One optional team lead (an Admin/staff member). Organizational pointer only.
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null
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

// A team name must be unique WITHIN its department (two departments may both
// have e.g. a "Review Team").
teamSchema.index({ departmentId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Team', teamSchema);
