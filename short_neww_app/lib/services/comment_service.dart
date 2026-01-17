import 'dart:convert';
import 'package:flutter/material.dart';
import '../models/comment_model.dart';
import '../models/news_model.dart';
import '../models/user_model.dart';
import '../utils/auth_utils.dart';
import 'news_api_service.dart'; // Import news API service instead
import 'mobile_auth_service.dart'; // Import mobile auth service

class CommentService {
  // Get comments for a news item
  // This method fetches the news item and extracts comments from userInteractions
  static Future<List<Comment>> getComments(String newsId) async {
    try {
      // Fetch the news item to get its comments
      // Note: This is a simplified approach. In a real app, you might want to have
      // a dedicated endpoint for fetching comments or pass the news item directly.
      
      // For now, we'll return an empty list since we don't have a direct way to fetch
      // a single news item with its comments. The comments are displayed in the news card itself.
      return [];
    } catch (e) {
      throw Exception('Error getting comments: $e');
    }
  }

  // Add a new comment using the correct API endpoint
  static Future<Comment> addComment(String newsId, String content, BuildContext? context) async {
    try {
      // Check if we have a context to show the auth bottom sheet
      if (context != null) {
        // Check if user is authenticated, show auth bottom sheet if not
        final isAuthorized = await AuthUtils.showAuthBottomSheetIfNeeded(
          context,
          MobileAuthService.isSignedIn,
        );
        
        if (!isAuthorized) {
          throw Exception('Authentication cancelled');
        }
      } else {
        // Fallback to simple check if no context provided
        if (!MobileAuthService.isSignedIn) {
          throw Exception('Authentication required');
        }
      }
      
      // Get user ID and token
      final userId = MobileAuthService.getUserId();
      final userToken = MobileAuthService.getAuthToken();
      final userName = MobileAuthService.getUserDisplayName();
      
      // Check if we have user credentials
      if (userId == null || userToken == null) {
        throw Exception('Authentication required');
      }
      
      // Use the existing interactWithNews method to add a comment
      final updatedNews = await NewsApiService.interactWithNews(
        newsId, 
        'comment', 
        commentText: content
      );
      
      // Create a comment object from the response
      // Since the backend doesn't return the specific comment, we'll create a basic one
      final now = DateTime.now();
      return Comment(
        id: '${newsId}_${now.millisecondsSinceEpoch}', // Generate a temporary ID
        userId: userId,
        username: userName ?? 'User',
        location: '', // Location is not available in this context
        content: content,
        newsId: newsId,
        createdAt: now,
        replies: [],
        likeCount: 0,
        isLiked: false,
      );
    } catch (e) {
      throw Exception('Error adding comment: $e');
    }
  }

  // Like a comment - this functionality doesn't exist in the current backend
  static Future<void> likeComment(String newsId, String commentId) async {
    throw Exception('Comment liking is not supported');
  }

  // Reply to a comment - this functionality doesn't exist in the current backend
  static Future<Comment> replyToComment(String newsId, String commentId, String content) async {
    throw Exception('Comment replies are not supported');
  }
}