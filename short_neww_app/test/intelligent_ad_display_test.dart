import 'package:flutter_test/flutter_test.dart';
import 'package:short_neww_app/models/ad_model.dart';
import 'package:short_neww_app/services/user_preference_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

// Helper function to test ad filtering logic
Future<List<AdModel>> _filterAdsBasedOnUserBehavior(List<AdModel> ads) async {
  // Get recent ad interactions (last 24 hours)
  final recentInteractions = await UserPreferenceService.getRecentAdInteractions(
    withinLast: Duration(hours: 24),
  );
  
  // Count how many times each ad has been seen recently
  final adSeenCounts = <String, int>{};
  for (var interaction in recentInteractions) {
    if (interaction['interactionType'] == 'view') {
      final adId = interaction['adId'] as String;
      adSeenCounts[adId] = (adSeenCounts[adId] ?? 0) + 1;
    }
  }
  
  // Filter out ads that have been seen more than 3 times in the last 24 hours
  final filteredAds = ads.where((ad) {
    final seenCount = adSeenCounts[ad.id] ?? 0;
    return seenCount < 3; // Show ads maximum 3 times in 24 hours
  }).toList();
  
  // If we have too few ads after filtering, add some back (but limit to 50% of original)
  if (filteredAds.length < ads.length ~/ 2) {
    final remainingAds = ads.where((ad) => !filteredAds.contains(ad)).toList();
    final adsToAdd = remainingAds.take(ads.length ~/ 2 - filteredAds.length).toList();
    filteredAds.addAll(adsToAdd);
  }
  
  return filteredAds;
}

void main() {
  group('Intelligent Ad Display Tests', () {
    setUp(() {
      // Clear shared preferences before each test
      SharedPreferences.setMockInitialValues({});
    });

    test('Filter ads based on user behavior', () async {
      // Create test ads
      final ads = [
        AdModel(
          id: 'ad1',
          title: 'Test Ad 1',
          imageUrl: 'https://example.com/image1.jpg',
          imageUrls: ['https://example.com/image1.jpg'],
          positionInterval: 3,
          createdAt: DateTime.now(),
        ),
        AdModel(
          id: 'ad2',
          title: 'Test Ad 2',
          imageUrl: 'https://example.com/image2.jpg',
          imageUrls: ['https://example.com/image2.jpg'],
          positionInterval: 3,
          createdAt: DateTime.now(),
        ),
        AdModel(
          id: 'ad3',
          title: 'Test Ad 3',
          imageUrl: 'https://example.com/image3.jpg',
          imageUrls: ['https://example.com/image3.jpg'],
          positionInterval: 3,
          createdAt: DateTime.now(),
        ),
      ];

      // Record multiple views for ad1 (more than threshold)
      for (int i = 0; i < 5; i++) {
        await UserPreferenceService.recordAdInteraction(
          adId: 'ad1',
          interactionType: 'view',
        );
      }

      // Test the filtering method directly
      final filteredAds = await _filterAdsBasedOnUserBehavior(ads);

      // ad1 should be filtered out due to excessive views
      expect(filteredAds.length, equals(2));
      expect(filteredAds.any((ad) => ad.id == 'ad1'), isFalse);
      expect(filteredAds.any((ad) => ad.id == 'ad2'), isTrue);
      expect(filteredAds.any((ad) => ad.id == 'ad3'), isTrue);
    });

    test('Track ad interactions', () async {
      // Record ad interaction
      await UserPreferenceService.recordAdInteraction(
        adId: 'test_ad',
        interactionType: 'click',
      );

      // Get recent interactions
      final interactions = await UserPreferenceService.getRecentAdInteractions();

      // Verify interaction was recorded
      expect(interactions.length, equals(1));
      expect(interactions[0]['adId'], equals('test_ad'));
      expect(interactions[0]['interactionType'], equals('click'));
    });

    test('Mark ad as seen', () async {
      // Mark ad as seen
      await UserPreferenceService.markAdAsSeen('test_ad');

      // Get last seen time
      final lastSeen = await UserPreferenceService.getLastSeenTime('test_ad');

      // Verify ad was marked as seen
      expect(lastSeen, isNotNull);
    });
  });
}