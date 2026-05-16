const mongoose = require('mongoose');

const registrationFieldSchema = new mongoose.Schema({
  label: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    required: true,
    enum: ['text', 'number', 'email', 'tel', 'textarea', 'select', 'checkbox', 'file', 'date'],
    default: 'text'
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  placeholder: {
    type: String,
    default: ''
  },
  required: {
    type: Boolean,
    default: false
  },
  options: [{
    type: String // For select dropdowns
  }],
  order: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('RegistrationField', registrationFieldSchema);
