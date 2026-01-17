import 'package:flutter_test/flutter_test.dart';
import 'package:short_neww_app/models/news_model.dart';

void main() {
  group('User Interaction Tests', () {
    test('UserInteraction model should be created correctly', () {
      final interaction = UserInteraction(
        userId: 'test_user_id',
        userName: 'Test User',
        userEmail: 'test@example.com',
        timestamp: DateTime.now(),
      );
      
      expect(interaction.userId, 'test_user_id');
      expect(interaction.userName, 'Test User');
      expect(interaction.userEmail, 'test@example.com');
      expect(interaction.timestamp, isNotNull);
    });
    
    test('UserInteraction model should parse from JSON', () {
      final json = {
        'userId': 'test_user_id',
        'userName': 'Test User',
        'userEmail': 'test@example.com',
        'timestamp': DateTime.now().toIso8601String(),
      };
      
      final interaction = UserInteraction.fromJson(json);
      
      expect(interaction.userId, 'test_user_id');
      expect(interaction.userName, 'Test User');
      expect(interaction.userEmail, 'test@example.com');
      expect(interaction.timestamp, isNotNull);
    });
    
    test('NewsModel should include user interactions', () {
      final news = NewsModel(
        id: '1',
        title: 'Test News',
        content: 'Test content',
        imageUrl: 'https://example.com/image.jpg',
        category: 'Test',
        publishedAt: DateTime.now(),
        likes: 5,
        dislikes: 2,
        comments: 3,
        author: 'Test Author',
        userLikes: [
          UserInteraction(
            userId: 'user1',
            userName: 'User One',
            timestamp: DateTime.now(),
          ),
        ],
        userDislikes: [
          UserInteraction(
            userId: 'user2',
            userName: 'User Two',
            timestamp: DateTime.now(),
          ),
        ],
        userComments: [
          UserInteraction(
            userId: 'user3',
            userName: 'User Three',
            comment: 'This is a test comment',
            timestamp: DateTime.now(),
          ),
        ],
      );
      
      expect(news.userLikes.length, 1);
      expect(news.userDislikes.length, 1);
      expect(news.userComments.length, 1);
      expect(news.userComments[0].comment, 'This is a test comment');
    });
  });
}