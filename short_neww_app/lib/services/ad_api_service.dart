import 'dart:convert';
import 'package:http/http.dart' as http;
import '../models/ad_model.dart';
import 'news_api_service.dart'; // Import to use the same base URL

class AdApiService {
  // Fetch all active ads from the admin backend
  static Future<List<AdModel>> fetchAds() async {
    try {
      final response = await http.get(
        Uri.parse('${NewsApiService.baseUrl}/api/public/ads'),
        headers: {
          'Content-Type': 'application/json',
        },
      );

      if (response.statusCode == 200) {
        final List<dynamic> jsonData = json.decode(response.body);
        return jsonData.map((json) => AdModel.fromJson(json)).toList();
      } else {
        print('Failed to fetch ads: ${response.statusCode}');
        throw Exception('Failed to fetch ads: ${response.statusCode}');
      }
    } catch (e) {
      print('Error fetching ads: $e');
      throw Exception('Error fetching ads: $e');
    }
  }
  
  // Send ad interaction data to backend for analytics
  static Future<void> sendAdInteraction({
    required String adId,
    required String adTitle,
    required String interactionType, // 'view', 'click'
    int? viewDurationSeconds,
  }) async {
    try {
      final url = Uri.parse('${NewsApiService.baseUrl}/api/public/ads/$adId/interaction');
      
      final response = await http.post(
        url,
        headers: {
          'Content-Type': 'application/json',
        },
        body: jsonEncode({
          'adId': adId,
          'adTitle': adTitle,
          'interactionType': interactionType,
          'viewDurationSeconds': viewDurationSeconds,
        }),
      );

      if (response.statusCode != 200) {
        print('Failed to send ad interaction: ${response.statusCode}');
        throw Exception('Failed to send ad interaction: ${response.statusCode}');
      }
    } catch (e) {
      print('Error sending ad interaction: $e');
      throw Exception('Error sending ad interaction: $e');
    }
  }
}