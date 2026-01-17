import 'package:shared_preferences/shared_preferences.dart';
import 'dart:convert';

class UserPreferenceService {
  static const String _seenAdsKey = 'seen_ads';
  static const String _adInteractionHistoryKey = 'ad_interaction_history';
  static const String _preferredCategoriesKey = 'preferred_categories';
  
  // Track when user has seen an ad
  static Future<void> markAdAsSeen(String adId) async {
    final prefs = await SharedPreferences.getInstance();
    final seenAdsJson = prefs.getString(_seenAdsKey) ?? '{}';
    final seenAds = jsonDecode(seenAdsJson) as Map<String, dynamic>;
    
    seenAds[adId] = DateTime.now().toIso8601String();
    
    await prefs.setString(_seenAdsKey, jsonEncode(seenAds));
  }
  
  // Get when user last saw an ad
  static Future<DateTime?> getLastSeenTime(String adId) async {
    final prefs = await SharedPreferences.getInstance();
    final seenAdsJson = prefs.getString(_seenAdsKey) ?? '{}';
    final seenAds = jsonDecode(seenAdsJson) as Map<String, dynamic>;
    
    if (seenAds.containsKey(adId)) {
      return DateTime.parse(seenAds[adId] as String);
    }
    
    return null;
  }
  
  // Record ad interaction (click, view time, etc.)
  static Future<void> recordAdInteraction({
    required String adId,
    required String interactionType, // 'view', 'click', 'swipe_away'
    int? viewDurationSeconds,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    final historyJson = prefs.getString(_adInteractionHistoryKey) ?? '[]';
    final history = (jsonDecode(historyJson) as List)
        .map((item) => item as Map<String, dynamic>)
        .toList();
    
    history.add({
      'adId': adId,
      'interactionType': interactionType,
      'timestamp': DateTime.now().toIso8601String(),
      'viewDurationSeconds': viewDurationSeconds,
    });
    
    // Keep only last 100 interactions to prevent storage bloat
    if (history.length > 100) {
      history.removeRange(0, history.length - 100);
    }
    
    await prefs.setString(_adInteractionHistoryKey, jsonEncode(history));
  }
  
  // Get recent ad interactions
  static Future<List<Map<String, dynamic>>> getRecentAdInteractions({
    int limit = 50,
    Duration? withinLast,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    final historyJson = prefs.getString(_adInteractionHistoryKey) ?? '[]';
    final history = (jsonDecode(historyJson) as List)
        .map((item) => item as Map<String, dynamic>)
        .toList();
    
    // Filter by time if specified
    if (withinLast != null) {
      final cutoffTime = DateTime.now().subtract(withinLast);
      history.removeWhere(
        (item) => DateTime.parse(item['timestamp'] as String).isBefore(cutoffTime),
      );
    }
    
    // Return last N items
    if (history.length > limit) {
      return history.sublist(history.length - limit);
    }
    
    return history;
  }
  
  // Add preferred category
  static Future<void> addPreferredCategory(String category) async {
    final prefs = await SharedPreferences.getInstance();
    final categoriesJson = prefs.getString(_preferredCategoriesKey) ?? '[]';
    final categories = (jsonDecode(categoriesJson) as List)
        .map((item) => item as String)
        .toList();
    
    if (!categories.contains(category)) {
      categories.add(category);
      await prefs.setString(_preferredCategoriesKey, jsonEncode(categories));
    }
  }
  
  // Remove preferred category
  static Future<void> removePreferredCategory(String category) async {
    final prefs = await SharedPreferences.getInstance();
    final categoriesJson = prefs.getString(_preferredCategoriesKey) ?? '[]';
    final categories = (jsonDecode(categoriesJson) as List)
        .map((item) => item as String)
        .toList();
    
    categories.remove(category);
    await prefs.setString(_preferredCategoriesKey, jsonEncode(categories));
  }
  
  // Get preferred categories
  static Future<List<String>> getPreferredCategories() async {
    final prefs = await SharedPreferences.getInstance();
    final categoriesJson = prefs.getString(_preferredCategoriesKey) ?? '[]';
    return (jsonDecode(categoriesJson) as List).map((item) => item as String).toList();
  }
  
  // Clear all preference data
  static Future<void> clearAllData() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_seenAdsKey);
    await prefs.remove(_adInteractionHistoryKey);
    await prefs.remove(_preferredCategoriesKey);
  }
}