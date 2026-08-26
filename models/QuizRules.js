'use strict';

/**
 * QuizRules — a single editable config doc (key: 'quiz_rules') holding the Daily
 * Quiz info sections shown in the app. Each section is { title, content }, so
 * titles/content can be added, edited or removed anytime via the admin API with
 * NO app code change. The app renders whatever sections it receives.
 */
const mongoose = require('mongoose');

const sectionSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  content: { type: String, default: '', trim: true },
}, { _id: false });

const quizRulesSchema = new mongoose.Schema({
  key: { type: String, default: 'quiz_rules', unique: true },
  title: { type: String, default: 'Daily Quiz' },
  sections: { type: [sectionSchema], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('QuizRules', quizRulesSchema);
