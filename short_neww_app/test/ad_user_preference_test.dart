import 'package:flutter_test/flutter_test.dart';
import 'package:short_neww_app/services/user_preference_service.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:convert';

void main() {
  group('User Preference Service Tests', () {
    setUp(() {
      // Clear shared preferences before each test
      SharedPreferences.setMockInitialValues({});
    });

    test('Record and retrieve ad interaction', () async {
      // Record ad interaction
      await UserPreferenceService.recordAdInteraction(
        adId: 'test_ad_1',
        interactionType: 'view',
      );

      // Get recent interactions
      final interactions = await UserPreferenceService.getRecentAdInteractions();

      // Verify interaction was recorded
      expect(interactions.length, equals(1));
      expect(interactions[0]['adId'], equals('test_ad_1'));
      expect(interactions[0]['interactionType'], equals('view'));
    });

    test('Mark and check ad seen status', () async {
      // Mark ad as seen
      await UserPreferenceService.markAdAsSeen('test_ad_2');

      // Get last seen time
      final lastSeen = await UserPreferenceService.getLastSeenTime('test_ad_2');

      // Verify ad was marked as seen
      expect(lastSeen, isNotNull);
    });

    test('Filter interactions by time', () async {
      // Record an old interaction (2 days ago)
      final prefs = await SharedPreferences.getInstance();
      final history = [
        {
          'adId': 'old_ad',
          'interactionType': 'view',
          'timestamp': DateTime.now().subtract(Duration(days: 2)).toIso8601String(),
        }
      ];
      await prefs.setString('ad_interaction_history', jsonEncode(history));

      // Get recent interactions (within last 24 hours)
      final recentInteractions = await UserPreferenceService.getRecentAdInteractions(
        withinLast: Duration(hours: 24),
      );

      // The old interaction should be filtered out
      expect(recentInteractions.length, equals(0));
    });
  });
}