const mongoose = require('mongoose');

// A state in-charge PROPOSES assigning a reporter to a district as a district
// in-charge / stringer. It stays "pending" until an admin approves it — only
// then is the assignment actually applied to the reporter's Admin doc.
const districtAssignmentRequestSchema = new mongoose.Schema({
  stateInchargeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true, index: true },
  stateInchargeName: { type: String, default: '' },

  reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true, index: true },
  reporterName: { type: String, default: '' },

  state: { type: String, required: true, trim: true },
  district: { type: String, required: true, trim: true },
  tier: { type: String, enum: ['district_incharge', 'stringer'], default: 'district_incharge' },

  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  reviewedByName: { type: String, default: '' },
  reviewedAt: { type: Date, default: null },
  rejectReason: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('DistrictAssignmentRequest', districtAssignmentRequestSchema);
