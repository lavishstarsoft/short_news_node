class UserInteraction {
  final String userId;
  final String userName;
  final String? userEmail;
  final String? comment;
  final DateTime timestamp;

  UserInteraction({
    required this.userId,
    required this.userName,
    this.userEmail,
    this.comment,
    required this.timestamp,
  });

  factory UserInteraction.fromJson(Map<String, dynamic> json) {
    // Handle potential null values for required String fields
    String userId = json['userId'] is String ? json['userId'] : '';
    String userName = json['userName'] is String ? json['userName'] : '';

    return UserInteraction(
      userId: userId,
      userName: userName,
      userEmail: json['userEmail'] is String ? json['userEmail'] : null,
      comment: json['comment'] is String ? json['comment'] : null,
      timestamp:
          json['timestamp'] != null
              ? DateTime.parse(json['timestamp'] as String)
              : DateTime.now(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'userId': userId,
      'userName': userName,
      'userEmail': userEmail,
      'comment': comment,
      'timestamp': timestamp.toIso8601String(),
    };
  }
}

class NewsModel {
  final String id;
  final String title;
  final String content;
  final String imageUrl;
  final String? mediaUrl; // New field for actual media URL (video or image)
  final String? mediaType;
  final String category;
  final String? location;
  final DateTime publishedAt;
  final int likes;
  final int dislikes;
  final int comments;
  final String author;
  final bool isRead; // Add this line to track if news is read
  final String? readFullLink; // Custom link for Read Full Article button
  final String? ePaperLink; // Custom link for ePaper button
  final List<UserInteraction> userLikes;
  final List<UserInteraction> userDislikes;
  final List<UserInteraction> userComments;

  NewsModel({
    required this.id,
    required this.title,
    required this.content,
    required this.imageUrl,
    this.mediaUrl,
    this.mediaType,
    required this.category,
    this.location,
    required this.publishedAt,
    required this.likes,
    required this.dislikes,
    required this.comments,
    required this.author,
    this.isRead = false, // Add this line with default value
    this.readFullLink,
    this.ePaperLink,
    this.userLikes = const [],
    this.userDislikes = const [],
    this.userComments = const [],
  });

  // Get truncated content (200 characters)
  String get truncatedContent {
    if (content.length <= 200) {
      return content;
    }
    return '${content.substring(0, 200)}...';
  }

  // Get time ago string
  String get timeAgo {
    final now = DateTime.now();
    final difference = now.difference(publishedAt);

    if (difference.inDays > 0) {
      return '${difference.inDays}d ago';
    } else if (difference.inHours > 0) {
      return '${difference.inHours}h ago';
    } else if (difference.inMinutes > 0) {
      return '${difference.inMinutes}m ago';
    } else {
      return 'Just now';
    }
  }

  // Copy with method for updating likes/dislikes
  NewsModel copyWith({
    String? id,
    String? title,
    String? content,
    String? imageUrl,
    String? mediaUrl,
    String? mediaType,
    String? category,
    String? location,
    DateTime? publishedAt,
    int? likes,
    int? dislikes,
    int? comments,
    String? author,
    bool? isRead, // Add this line
    String? readFullLink,
    String? ePaperLink,
    List<UserInteraction>? userLikes,
    List<UserInteraction>? userDislikes,
    List<UserInteraction>? userComments,
  }) {
    return NewsModel(
      id: id ?? this.id,
      title: title ?? this.title,
      content: content ?? this.content,
      imageUrl: imageUrl ?? this.imageUrl,
      mediaUrl: mediaUrl ?? this.mediaUrl,
      mediaType: mediaType ?? this.mediaType,
      category: category ?? this.category,
      location: location ?? this.location,
      publishedAt: publishedAt ?? this.publishedAt,
      likes: likes ?? this.likes,
      dislikes: dislikes ?? this.dislikes,
      comments: comments ?? this.comments,
      author: author ?? this.author,
      isRead: isRead ?? this.isRead, // Add this line
      readFullLink: readFullLink ?? this.readFullLink,
      ePaperLink: ePaperLink ?? this.ePaperLink,
      userLikes: userLikes ?? this.userLikes,
      userDislikes: userDislikes ?? this.userDislikes,
      userComments: userComments ?? this.userComments,
    );
  }

  // Helper method to parse dates from various formats
  static DateTime _parseDate(dynamic dateValue) {
    if (dateValue == null) {
      print('⚠️ Date value is null, using DateTime.now()');
      return DateTime.now();
    }

    try {
      // If it's already a DateTime
      if (dateValue is DateTime) {
        return dateValue;
      }

      // Check for numbers FIRST (GraphQL returns timestamps as numbers)
      if (dateValue is int) {
        // Check if it's in seconds or milliseconds
        if (dateValue > 10000000000) {
          // Milliseconds
          final parsed = DateTime.fromMillisecondsSinceEpoch(dateValue);
          print('✅ Parsed timestamp (ms): $dateValue -> $parsed');
          return parsed;
        } else {
          // Seconds
          final parsed = DateTime.fromMillisecondsSinceEpoch(dateValue * 1000);
          print('✅ Parsed timestamp (s): $dateValue -> $parsed');
          return parsed;
        }
      }

      // If it's a string that looks like a number, parse it as int first
      if (dateValue is String) {
        // Try parsing as number first
        final numValue = int.tryParse(dateValue);
        if (numValue != null) {
          if (numValue > 10000000000) {
            final parsed = DateTime.fromMillisecondsSinceEpoch(numValue);
            print('✅ Parsed string number (ms): $dateValue -> $parsed');
            return parsed;
          } else {
            final parsed = DateTime.fromMillisecondsSinceEpoch(numValue * 1000);
            print('✅ Parsed string number (s): $dateValue -> $parsed');
            return parsed;
          }
        }

        // Otherwise try ISO format
        try {
          final parsed = DateTime.parse(dateValue);
          print('✅ Parsed date string: $dateValue -> $parsed');
          return parsed;
        } catch (e) {
          print('❌ Failed to parse date string: $dateValue, error: $e');
          return DateTime.now();
        }
      }

      // Fallback
      print(
        '⚠️ Unknown date format: $dateValue (${dateValue.runtimeType}), using DateTime.now()',
      );
      return DateTime.now();
    } catch (e) {
      print(
        '❌ Error parsing date: $e, value: $dateValue (${dateValue.runtimeType})',
      );
      return DateTime.now();
    }
  }

  // Factory method to create NewsModel from JSON
  factory NewsModel.fromJson(Map<String, dynamic> json) {
    // Parse user interactions safely
    List<UserInteraction> likes = [];
    List<UserInteraction> dislikes = [];
    List<UserInteraction> comments = [];

    if (json['userLikes'] != null) {
      try {
        likes =
            (json['userLikes'] as List)
                .map(
                  (item) =>
                      UserInteraction.fromJson(item as Map<String, dynamic>),
                )
                .toList();
      } catch (e) {
        print('Error parsing userLikes: $e');
        likes = [];
      }
    }

    if (json['userDislikes'] != null) {
      try {
        dislikes =
            (json['userDislikes'] as List)
                .map(
                  (item) =>
                      UserInteraction.fromJson(item as Map<String, dynamic>),
                )
                .toList();
      } catch (e) {
        print('Error parsing userDislikes: $e');
        dislikes = [];
      }
    }

    if (json['userComments'] != null) {
      try {
        comments =
            (json['userComments'] as List)
                .map(
                  (item) =>
                      UserInteraction.fromJson(item as Map<String, dynamic>),
                )
                .toList();
      } catch (e) {
        print('Error parsing userComments: $e');
        comments = [];
      }
    }

    // Handle potential null values for required String fields
    String id = json['id'] is String ? json['id'] : '';
    String title = json['title'] is String ? json['title'] : '';
    String content = json['content'] is String ? json['content'] : '';
    String imageUrl = json['imageUrl'] is String ? json['imageUrl'] : '';
    String category = json['category'] is String ? json['category'] : '';
    String author = json['author'] is String ? json['author'] : '';

    // Handle potential null values for optional fields
    String? mediaUrl = json['mediaUrl'] is String ? json['mediaUrl'] : null;
    String? mediaType = json['mediaType'] is String ? json['mediaType'] : null;
    String? location = json['location'] is String ? json['location'] : null;

    return NewsModel(
      id: id,
      title: title,
      content: content,
      imageUrl: imageUrl,
      mediaUrl: mediaUrl,
      mediaType: mediaType,
      category: category,
      location: location,
      publishedAt: _parseDate(json['publishedAt']),
      likes: json['likes'] is int ? json['likes'] : 0,
      dislikes: json['dislikes'] is int ? json['dislikes'] : 0,
      comments: json['comments'] is int ? json['comments'] : 0,
      author: author,
      isRead: json['isRead'] is bool ? json['isRead'] : false,
      readFullLink:
          json['readFullLink'] is String ? json['readFullLink'] : null,
      ePaperLink: json['ePaperLink'] is String ? json['ePaperLink'] : null,
      userLikes: likes,
      userDislikes: dislikes,
      userComments: comments,
    );
  }

  // Method to convert NewsModel to JSON
  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'title': title,
      'content': content,
      'imageUrl': imageUrl,
      'mediaUrl': mediaUrl, // New field
      'mediaType': mediaType,
      'category': category,
      'location': location,
      'publishedAt': publishedAt.toIso8601String(),
      'likes': likes,
      'dislikes': dislikes,
      'comments': comments,
      'author': author,
      'isRead': isRead, // Add this line
      'readFullLink': readFullLink,
      'ePaperLink': ePaperLink,
      'userLikes': userLikes.map((item) => item.toJson()).toList(),
      'userDislikes': userDislikes.map((item) => item.toJson()).toList(),
      'userComments': userComments.map((item) => item.toJson()).toList(),
    };
  }
}
