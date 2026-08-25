'use strict';

/**
 * QuizQuestion — MCQ pool for the Daily Quiz. correctOption is SERVER-ONLY; it is
 * never sent to the app before a user submits. Once a question is used in a
 * COMPLETED (closed) week, its options/correctOption become immutable
 * (lockedForEdit); only isActive may still be toggled.
 */
const mongoose = require('mongoose');

const optionSchema = new mongoose.Schema({
  key: { type: String, enum: ['A', 'B', 'C', 'D'], required: true },
  text: { type: String, required: true, trim: true, maxlength: 300 },
}, { _id: false });

const quizQuestionSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true, maxlength: 500 },
  options: { type: [optionSchema], required: true },
  correctOption: { type: String, enum: ['A', 'B', 'C', 'D'], required: true },
  language: { type: String, default: 'te', trim: true },
  category: { type: String, default: null, trim: true },
  isActive: { type: Boolean, default: true },
  archived: { type: Boolean, default: false }, // soft-removed: excluded from the pool, NEVER hard-deleted
  usageCount: { type: Number, default: 0 },
  lockedForEdit: { type: Boolean, default: false },
  createdByName: { type: String, default: '' },
}, { timestamps: true });

quizQuestionSchema.index({ isActive: 1 });
quizQuestionSchema.index({ language: 1, isActive: 1 });

module.exports = mongoose.model('QuizQuestion', quizQuestionSchema);
