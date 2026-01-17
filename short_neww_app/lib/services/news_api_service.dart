import 'dart:io' show Platform;
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../models/news_model.dart';
import '../models/user_model.dart';
import 'mobile_auth_service.dart'; // Import mobile auth service

class NewsApiService {
  // Base URL for the admin backend
  static String get baseUrl {
    // Use your machine's IP address for real device testing
    // Replace '192.168.0.127' with your actual machine IP address
    return 'https://shortnews-production.up.railway.app';
  }

  // Fetch all news from the admin backend
  static Future<List<NewsModel>> fetchNews() async {
    try {
      final response = await http.get(
        Uri.parse('$baseUrl/api/public/news'),
        headers: {'Content-Type': 'application/json'},
      );

      if (response.statusCode == 200) {
        final List<dynamic> jsonData = json.decode(response.body);
        return jsonData.map((json) => NewsModel.fromJson(json)).toList();
      } else {
        print('Failed to fetch news: ${response.statusCode}');
        throw Exception('Failed to fetch news: ${response.statusCode}');
      }
    } catch (e) {
      print('Error fetching news: $e');
      throw Exception('Error fetching news: $e');
    }
  }

  // Fetch news by category
  static Future<List<NewsModel>> fetchNewsByCategory(String category) async {
    try {
      final response = await http.get(
        Uri.parse('$baseUrl/api/public/news?category=$category'),
        headers: {'Content-Type': 'application/json'},
      );

      if (response.statusCode == 200) {
        final List<dynamic> jsonData = json.decode(response.body);
        return jsonData.map((json) => NewsModel.fromJson(json)).toList();
      } else {
        print('Failed to fetch news by category: ${response.statusCode}');
        throw Exception(
          'Failed to fetch news by category: ${response.statusCode}',
        );
      }
    } catch (e) {
      print('Error fetching news by category: $e');
      throw Exception('Error fetching news by category: $e');
    }
  }

  // Fetch news by location
  static Future<List<NewsModel>> fetchNewsByLocation(String location) async {
    try {
      final response = await http.get(
        Uri.parse('$baseUrl/api/public/news/location/$location'),
        headers: {'Content-Type': 'application/json'},
      );

      if (response.statusCode == 200) {
        final List<dynamic> jsonData = json.decode(response.body);
        return jsonData.map((json) => NewsModel.fromJson(json)).toList();
      } else {
        print('Failed to fetch news by location: ${response.statusCode}');
        throw Exception(
          'Failed to fetch news by location: ${response.statusCode}',
        );
      }
    } catch (e) {
      print('Error fetching news by location: $e');
      throw Exception('Error fetching news by location: $e');
    }
  }

  // Fetch all locations
  static Future<List<Map<String, dynamic>>> fetchLocations() async {
    try {
      final response = await http.get(
        Uri.parse('$baseUrl/api/public/locations'),
        headers: {'Content-Type': 'application/json'},
      );

      if (response.statusCode == 200) {
        final List<dynamic> jsonData = json.decode(response.body);
        return jsonData.cast<Map<String, dynamic>>();
      } else {
        print('Failed to fetch locations: ${response.statusCode}');
        throw Exception('Failed to fetch locations: ${response.statusCode}');
      }
    } catch (e) {
      print('Error fetching locations: $e');
      throw Exception('Error fetching locations: $e');
    }
  }

  // New method to handle user interactions (like, dislike, comment) with authentication
  static Future<NewsModel> interactWithNews(
    String newsId,
    String action, {
    String? commentText,
  }) async {
    try {
      // Check if user is signed in with mobile
      if (MobileAuthService.isSignedIn) {
        final userId = MobileAuthService.getUserId();
        final userToken = MobileAuthService.getAuthToken();

        // Check if user is authenticated
        if (userId == null || userToken == null) {
          throw Exception('Authentication required');
        }

        final Map<String, dynamic> requestBody = {
          'action': action,
          'userId': userId,
          'userToken': userToken,
        };

        // Add comment text if provided
        if (commentText != null) {
          requestBody['commentText'] = commentText;
        }

        final response = await http.post(
          Uri.parse('$baseUrl/api/public/news/$newsId/interact'),
          headers: {'Content-Type': 'application/json'},
          body: json.encode(requestBody),
        );

        if (response.statusCode == 200) {
          final Map<String, dynamic> jsonData = json.decode(response.body);
          return NewsModel.fromJson(jsonData);
        } else {
          print('Failed to interact with news: ${response.statusCode}');
          throw Exception(
            'Failed to interact with news: ${response.statusCode}',
          );
        }
      }

      // No authentication
      throw Exception('Authentication required');
    } catch (e) {
      print('Error interacting with news: $e');
      throw Exception('Error interacting with news: $e');
    }
  }

  // New method to fetch user profile data
  static Future<UserModel> fetchUserProfile() async {
    try {
      // Check if user is signed in with mobile
      if (MobileAuthService.isSignedIn) {
        final userId = MobileAuthService.getUserId();
        final userToken = MobileAuthService.getAuthToken();

        // Check if user is authenticated
        if (userId == null || userToken == null) {
          throw Exception('Authentication required');
        }

        final Map<String, dynamic> requestBody = {
          'userId': userId,
          'userToken': userToken,
        };

        final response = await http.post(
          Uri.parse('$baseUrl/api/public/user/profile'),
          headers: {'Content-Type': 'application/json'},
          body: json.encode(requestBody),
        );

        if (response.statusCode == 200) {
          final Map<String, dynamic> jsonData = json.decode(response.body);
          return UserModel.fromJson(jsonData);
        } else {
          print('Failed to fetch user profile: ${response.statusCode}');
          throw Exception(
            'Failed to fetch user profile: ${response.statusCode}',
          );
        }
      }

      // No authentication
      throw Exception('Authentication required');
    } catch (e) {
      print('Error fetching user profile: $e');
      throw Exception('Error fetching user profile: $e');
    }
  }

  // Get full image URL (handles relative URLs from admin backend)
  static String getFullImageUrl(String imageUrl) {
    if (imageUrl.startsWith('http')) {
      return imageUrl;
    } else if (imageUrl.startsWith('/')) {
      return '$baseUrl$imageUrl';
    } else {
      return '$baseUrl/$imageUrl';
    }
  }

  // Fetch viral videos
  static Future<List<Map<String, dynamic>>> getViralVideos() async {
    try {
      final response = await http.get(
        Uri.parse('$baseUrl/api/public/viral-videos'),
        headers: {'Content-Type': 'application/json'},
      );

      if (response.statusCode == 200) {
        final List<dynamic> jsonData = json.decode(response.body);
        return jsonData.cast<Map<String, dynamic>>();
      } else {
        print('Failed to fetch viral videos: ${response.statusCode}');
        throw Exception('Failed to fetch viral videos');
      }
    } catch (e) {
      print('Error fetching viral videos: $e');
      throw Exception('Error fetching viral videos: $e');
    }
  }

  // Report a news item
  static Future<Map<String, dynamic>> reportNews(
    String newsId,
    String reason,
    String description,
  ) async {
    try {
      // Check if user is signed in with mobile
      if (!MobileAuthService.isSignedIn) {
        throw Exception('Authentication required');
      }

      // Get user details if authenticated with mobile
      final userId = MobileAuthService.getUserId();
      final userMobileNumber = MobileAuthService.getUserMobileNumber();
      final userName = MobileAuthService.getUserDisplayName();

      // Check if user is authenticated
      if (userId == null) {
        throw Exception('Authentication required');
      }

      final Map<String, dynamic> requestBody = {
        'reason': reason,
        'description': description,
        'userId': userId,
        'userEmail':
            userMobileNumber, // Send mobile number as userEmail for backward compatibility
        'userName': userName,
        'mobileNumber': userMobileNumber, // Also send mobile number explicitly
      };

      final response = await http.post(
        Uri.parse('$baseUrl/api/public/news/$newsId/report'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode(requestBody),
      );

      final Map<String, dynamic> jsonData = json.decode(response.body);

      if (response.statusCode == 201) {
        return {'success': true, 'message': jsonData['message']};
      } else {
        return {'success': false, 'message': jsonData['message']};
      }
    } catch (e) {
      print('Error reporting news: $e');
      throw Exception('Error reporting news: $e');
    }
  }

  // Interact with viral video
  static Future<Map<String, dynamic>> interactWithViralVideo(
    String videoId,
    String action, {
    String? commentText,
  }) async {
    try {
      // Check if user is signed in with mobile
      if (!MobileAuthService.isSignedIn) {
        throw Exception('Authentication required');
      }

      final userId = MobileAuthService.getUserId();
      final userToken = MobileAuthService.getAuthToken();

      if (userId == null || userToken == null) {
        throw Exception('Authentication required');
      }

      final Map<String, dynamic> requestBody = {
        'action': action,
        'userId': userId,
        'userToken': userToken,
      };

      if (commentText != null) {
        requestBody['commentText'] = commentText;
      }

      final response = await http.post(
        Uri.parse('$baseUrl/api/public/viral-videos/$videoId/interact'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode(requestBody),
      );

      if (response.statusCode == 200) {
        return json.decode(response.body);
      } else {
        print('Failed to interact with viral video: ${response.statusCode}');
        throw Exception(
          'Failed to interact with viral video: ${response.statusCode}',
        );
      }
    } catch (e) {
      print('Error interacting with viral video: $e');
      throw Exception('Error interacting with viral video: $e');
    }
  }
}
