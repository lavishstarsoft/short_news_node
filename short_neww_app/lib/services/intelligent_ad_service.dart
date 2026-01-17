import 'dart:async';
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:convert';
import '../models/ad_model.dart';
import 'user_preference_service.dart';
import 'ad_api_service.dart';

class IntelligentAdService {
  static const String _adAnalyticsKey = 'ad_analytics';
  static const String _adFrequencySettingsKey = 'ad_frequency_settings';
  
  // Default frequency settings
  static const int _defaultMaxViewsPerDay = 3;
  static const int _defaultCooldownPeriodHours = 24;
  
  // Get ad frequency settings
  static Future<Map<String, dynamic>> getAdFrequencySettings(String adId) async {
    final prefs = await SharedPreferences.getInstance();
    final settingsJson = prefs.getString(_adFrequencySettingsKey) ?? '{}';
    final allSettings = jsonDecode(settingsJson) as Map<String, dynamic>;
    
    // Return ad-specific settings or defaults
    if (allSettings.containsKey(adId)) {
      return allSettings[adId] as Map<String, dynamic>;
    }
    
    // Return default settings
    return {
      'maxViewsPerDay': _defaultMaxViewsPerDay,
      'cooldownPeriodHours': _defaultCooldownPeriodHours,
      'frequencyControlEnabled': true,
      'userBehaviorTrackingEnabled': true
    };
  }
  
  // Set ad frequency settings
  static Future<void> setAdFrequencySettings(String adId, Map<String, dynamic> settings) async {
    final prefs = await SharedPreferences.getInstance();
    final settingsJson = prefs.getString(_adFrequencySettingsKey) ?? '{}';
    final allSettings = jsonDecode(settingsJson) as Map<String, dynamic>;
    
    allSettings[adId] = settings;
    
    await prefs.setString(_adFrequencySettingsKey, jsonEncode(allSettings));
  }
  
  // Check if ad should be shown based on frequency settings
  static Future<bool> shouldShowAd(AdModel ad) async {
    // Get frequency settings for this ad
    final settings = await getAdFrequencySettings(ad.id);
    
    // If frequency control is disabled, always show the ad
    if (!(settings['frequencyControlEnabled'] as bool? ?? true)) {
      return true;
    }
    
    // Get recent interactions for this ad
    final recentInteractions = await UserPreferenceService.getRecentAdInteractions(
      withinLast: Duration(hours: 24),
    );
    
    // Filter interactions for this specific ad
    final adInteractions = recentInteractions.where((interaction) {
      return interaction['adId'] == ad.id;
    }).toList();
    
    // Check max views per day
    final maxViewsPerDay = settings['maxViewsPerDay'] as int? ?? _defaultMaxViewsPerDay;
    if (adInteractions.length >= maxViewsPerDay) {
      return false;
    }
    
    // Check cooldown period
    final cooldownPeriodHours = settings['cooldownPeriodHours'] as int? ?? _defaultCooldownPeriodHours;
    if (adInteractions.isNotEmpty) {
      final lastInteraction = adInteractions.last;
      final lastTimestamp = DateTime.parse(lastInteraction['timestamp'] as String);
      final cooldownEnd = lastTimestamp.add(Duration(hours: cooldownPeriodHours));
      
      // If cooldown period hasn't expired, don't show the ad
      if (DateTime.now().isBefore(cooldownEnd)) {
        return false;
      }
    }
    
    return true;
  }
  
  // Filter ads based on intelligent criteria
  static Future<List<AdModel>> filterAdsIntelligently(List<AdModel> ads) async {
    final List<AdModel> filteredAds = [];
    
    for (final ad in ads) {
      // Check if ad should be shown based on frequency settings
      if (await shouldShowAd(ad)) {
        filteredAds.add(ad);
      }
    }
    
    // If we have too few ads after filtering, add some back
    if (filteredAds.length < ads.length ~/ 2) {
      final remainingAds = ads.where((ad) => !filteredAds.contains(ad)).toList();
      final adsToAdd = remainingAds.take(ads.length ~/ 2 - filteredAds.length).toList();
      filteredAds.addAll(adsToAdd);
    }
    
    return filteredAds;
  }
  
  // Record ad analytics locally and send to backend
  static Future<void> recordAdAnalytics({
    required String adId,
    required String adTitle,
    required String interactionType,
    int? viewDurationSeconds,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    final analyticsJson = prefs.getString(_adAnalyticsKey) ?? '{}';
    final allAnalytics = jsonDecode(analyticsJson) as Map<String, dynamic>;
    
    // Get or create analytics for this ad
    final adAnalytics = allAnalytics[adId] as Map<String, dynamic>? ?? {
      'impressions': 0,
      'clicks': 0,
      'totalViewDuration': 0,
      'uniqueViews': 0,
      'lastInteraction': DateTime.now().toIso8601String(),
    };
    
    // Update analytics based on interaction type
    if (interactionType == 'view') {
      adAnalytics['impressions'] = (adAnalytics['impressions'] as int) + 1;
      adAnalytics['uniqueViews'] = (adAnalytics['uniqueViews'] as int) + 1;
      
      if (viewDurationSeconds != null) {
        adAnalytics['totalViewDuration'] = (adAnalytics['totalViewDuration'] as int) + viewDurationSeconds;
      }
    } else if (interactionType == 'click') {
      adAnalytics['clicks'] = (adAnalytics['clicks'] as int) + 1;
    }
    
    // Update last interaction timestamp
    adAnalytics['lastInteraction'] = DateTime.now().toIso8601String();
    
    // Calculate CTR
    final impressions = adAnalytics['impressions'] as int;
    final clicks = adAnalytics['clicks'] as int;
    final ctr = impressions > 0 ? (clicks / impressions) * 100 : 0.0;
    adAnalytics['ctr'] = ctr;
    
    // Save updated analytics
    allAnalytics[adId] = adAnalytics;
    await prefs.setString(_adAnalyticsKey, jsonEncode(allAnalytics));
    
    // Also send to backend for real-time tracking
    try {
      await AdApiService.sendAdInteraction(
        adId: adId,
        adTitle: adTitle,
        interactionType: interactionType,
        viewDurationSeconds: viewDurationSeconds,
      );
    } catch (e) {
      print('Error sending ad interaction to backend: $e');
    }
  }
  
  // Get ad analytics
  static Future<Map<String, dynamic>> getAdAnalytics(String adId) async {
    final prefs = await SharedPreferences.getInstance();
    final analyticsJson = prefs.getString(_adAnalyticsKey) ?? '{}';
    final allAnalytics = jsonDecode(analyticsJson) as Map<String, dynamic>;
    
    return allAnalytics[adId] as Map<String, dynamic>? ?? {};
  }
  
  // Get all ad analytics
  static Future<Map<String, dynamic>> getAllAdAnalytics() async {
    final prefs = await SharedPreferences.getInstance();
    final analyticsJson = prefs.getString(_adAnalyticsKey) ?? '{}';
    return jsonDecode(analyticsJson) as Map<String, dynamic>;
  }
  
  // Clear ad analytics
  static Future<void> clearAdAnalytics() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_adAnalyticsKey);
  }
  
  // Sync local analytics with backend
  static Future<void> syncAnalyticsWithBackend() async {
    try {
      final allAnalytics = await getAllAdAnalytics();
      
      // Send each ad's analytics to the backend
      for (final entry in allAnalytics.entries) {
        final adId = entry.key;
        final analytics = entry.value as Map<String, dynamic>;
        
        // We could implement batch sending here if needed
        // For now, we're sending interactions in real-time through recordAdAnalytics
      }
    } catch (e) {
      print('Error syncing analytics with backend: $e');
    }
  }
  
  // Update ad frequency settings from backend
  static Future<void> updateAdFrequencySettingsFromBackend(AdModel ad) async {
    try {
      // Update local settings with ad model values or defaults
      final settings = {
        'maxViewsPerDay': ad.maxViewsPerDay ?? _defaultMaxViewsPerDay,
        'cooldownPeriodHours': ad.cooldownPeriodHours ?? _defaultCooldownPeriodHours,
        'frequencyControlEnabled': ad.frequencyControlEnabled ?? true,
        'userBehaviorTrackingEnabled': ad.userBehaviorTrackingEnabled ?? true
      };
      
      await setAdFrequencySettings(ad.id, settings);
    } catch (e) {
      print('Error updating ad frequency settings from backend: $e');
    }
  }
}