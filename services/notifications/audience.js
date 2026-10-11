'use strict';

/**
 * Turns "who should get this" into OneSignal targeting.
 *
 * Two ways to reach a phone:
 *  • filters on tags the app sets (news_language, user_state, user_district) —
 *    used for everyone / language / state / district;
 *  • include_aliases.external_id — used for named people.
 *
 * Alias formats, and why they differ:
 *  • a REPORTER is the bare Admin _id. That is what the live app already sends
 *    (ReporterPushService.bindReporter → OneSignal.login(reporterId)) and what
 *    services/reporterNotifier.js already targets, so reporter sends work on
 *    phones that never update the app. Do not "tidy" this into a prefix.
 *  • a normal READER is `u:<userId>`, set by newer app builds. The prefix keeps
 *    the two id spaces apart, and marks a reader alias as ours.
 *
 * A named send with an EMPTY list must never fall through to "everyone" — that
 * would blast the whole user base. resolve() throws instead.
 */
const Admin = require('../../models/Admin');
const User = require('../../models/User');
const { normalizeNewsLanguage } = require('../../utils/newsLanguages');

const TAG = { language: 'news_language', state: 'user_state', district: 'user_district' };

/** Same normalising the app uses, so a tag written by the phone always matches. */
const tagValue = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, '_').slice(0, 60);

const aliasForReporter = (id) => String(id);        // bare id — matches the live app
const aliasForUser = (id) => `u:${String(id)}`;

/**
 * Targeting by alias. OneSignal REJECTS include_aliases unless target_channel
 * is set ("target_channel must be specified when using targeting by alias"),
 * so the two must always travel together — services/reporterNotifier.js does
 * the same. Segment/tag targeting does not take it.
 */
const byAlias = (externalIds) => ({
  target_channel: 'push',
  include_aliases: { external_id: externalIds },
});

class EmptyAudienceError extends Error {
  // status 400: this is always the sender forgetting to choose, not a server fault.
  constructor(message) { super(message); this.code = 'EMPTY_AUDIENCE'; this.status = 400; }
}

/**
 * @returns {{ targeting: object, describe: string, estimate: number|null }}
 *   `targeting` is merged straight onto the OneSignal notification.
 */
async function resolve(audience = {}) {
  const kind = String(audience.kind || 'all');

  switch (kind) {
    case 'all': {
      // Estimate = registered signed-in app users (best server-side proxy; FCM
      // topics don't report a delivered count). Shown as "~N" in the Studio.
      const estimate = await User.estimatedDocumentCount().catch(() => null);
      return { targeting: { included_segments: ['Subscribed Users'] }, describe: 'Everyone', estimate };
    }

    case 'language': {
      // Check the raw value FIRST: normalizeNewsLanguage() falls back to the default
      // language for a blank input, which would quietly send Telugu readers a
      // notification the desk never chose to send them.
      if (!String(audience.language || '').trim()) throw new EmptyAudienceError('Choose a language.');
      const lang = normalizeNewsLanguage(audience.language);
      if (!lang) throw new EmptyAudienceError('Choose a language.');
      return {
        targeting: { filters: [{ field: 'tag', key: TAG.language, relation: '=', value: lang }] },
        describe: `Readers of ${lang}`,
        estimate: null,
      };
    }

    case 'state': {
      const state = tagValue(audience.state);
      if (!state) throw new EmptyAudienceError('Choose a state.');
      const estimate = await User.countDocuments({ 'locationProfile.primaryState': audience.state }).catch(() => null);
      return {
        targeting: { filters: [{ field: 'tag', key: TAG.state, relation: '=', value: state }] },
        describe: `Readers in ${audience.state}`,
        estimate,
      };
    }

    case 'district': {
      const district = tagValue(audience.district);
      if (!district) throw new EmptyAudienceError('Choose a district.');
      const estimate = await User.countDocuments({ 'locationProfile.primaryDistrict': audience.district }).catch(() => null);
      return {
        targeting: { filters: [{ field: 'tag', key: TAG.district, relation: '=', value: district }] },
        describe: `Readers in ${audience.district}`,
        estimate,
      };
    }

    case 'reporters': {
      const ids = await Admin.distinct('_id', { role: { $in: ['editor', 'subeditor'] }, isActive: { $ne: false } });
      if (!ids.length) throw new EmptyAudienceError('No active reporters found.');
      return {
        targeting: byAlias(ids.map(aliasForReporter)),
        describe: `All reporters (${ids.length})`,
        estimate: ids.length,
      };
    }

    case 'reporter_list': {
      const ids = (audience.reporterIds || []).filter(Boolean);
      if (!ids.length) throw new EmptyAudienceError('Pick at least one reporter.');
      return {
        targeting: byAlias(ids.map(aliasForReporter)),
        describe: ids.length === 1 ? '1 reporter' : `${ids.length} reporters`,
        estimate: ids.length,
      };
    }

    case 'user_list': {
      const ids = (audience.userIds || []).filter(Boolean);
      if (!ids.length) throw new EmptyAudienceError('Pick at least one app user.');
      // The app registers its Google account id (AuthService.currentUser.id), not the
      // Mongo _id, so translate here. A reader who signed in with a mobile number only
      // has no googleId and therefore no alias — say so instead of sending to nobody.
      const rows = await User.find({ _id: { $in: ids } }).select('googleId displayName').lean();
      const withAlias = rows.filter((u) => u.googleId && String(u.googleId).trim());
      if (!withAlias.length) {
        throw new EmptyAudienceError(
          'None of those readers can be reached one-by-one: they signed in without a Google account. Send by district or language instead.');
      }
      const skipped = ids.length - withAlias.length;
      return {
        targeting: byAlias(withAlias.map((u) => aliasForUser(u.googleId))),
        describe: (withAlias.length === 1 ? '1 app user' : `${withAlias.length} app users`)
          + (skipped ? ` (${skipped} skipped — no Google sign-in)` : ''),
        estimate: withAlias.length,
      };
    }

    default:
      throw new EmptyAudienceError(`Unknown audience "${kind}".`);
  }
}

module.exports = { resolve, byAlias, TAG, tagValue, aliasForReporter, aliasForUser, EmptyAudienceError };
