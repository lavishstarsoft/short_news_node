class UserModel {
  final String userId;
  final String displayName;
  final String? email;
  final String? mobileNumber; // Add mobile number field
  final String? photoUrl;
  final DateTime createdAt;
  final DateTime lastLogin;
  final UserStats stats;
  final UserInteractions interactions;

  UserModel({
    required this.userId,
    required this.displayName,
    this.email,
    this.mobileNumber, // Add mobile number parameter
    this.photoUrl,
    required this.createdAt,
    required this.lastLogin,
    required this.stats,
    required this.interactions,
  });

  factory UserModel.fromJson(Map<String, dynamic> json) {
    // Handle potential null values for required String fields by providing default values
    String userId = json['userId'] is String ? json['userId'] : '';
    String displayName = json['displayName'] is String ? json['displayName'] : '';
    
    // Handle email and mobile number
    String? email = json['email'] is String ? json['email'] : null;
    String? mobileNumber;
    
    // Extract mobile number from email if it's a mobile user
    if (email != null && email.endsWith('@mobile.user')) {
      mobileNumber = email.replaceAll('@mobile.user', '');
      email = null; // Clear email for mobile users
    }

    return UserModel(
      userId: userId,
      displayName: displayName,
      email: email,
      mobileNumber: mobileNumber, // Add mobile number
      photoUrl: json['photoUrl'],
      createdAt: json['createdAt'] != null 
          ? DateTime.parse(json['createdAt'])
          : DateTime.now(),
      lastLogin: json['lastLogin'] != null 
          ? DateTime.parse(json['lastLogin'])
          : DateTime.now(),
      stats: json['stats'] != null 
          ? UserStats.fromJson(json['stats'])
          : UserStats(likes: 0, dislikes: 0, comments: 0),
      interactions: json['interactions'] != null 
          ? UserInteractions.fromJson(json['interactions'])
          : UserInteractions(likes: [], dislikes: [], comments: []),
    );
  }

  Map<String, dynamic> toJson() {
    // For mobile users, we store the mobile number in the email field in the backend
    String? emailToStore = email;
    if (emailToStore == null && mobileNumber != null) {
      emailToStore = '$mobileNumber@mobile.user';
    }

    return {
      'userId': userId,
      'displayName': displayName,
      'email': emailToStore,
      'mobileNumber': mobileNumber,
      'photoUrl': photoUrl,
      'createdAt': createdAt.toIso8601String(),
      'lastLogin': lastLogin.toIso8601String(),
      'stats': stats.toJson(),
      'interactions': interactions.toJson(),
    };
  }
}

class UserStats {
  final int likes;
  final int dislikes;
  final int comments;

  UserStats({
    required this.likes,
    required this.dislikes,
    required this.comments,
  });

  factory UserStats.fromJson(Map<String, dynamic> json) {
    return UserStats(
      likes: json['likes'] ?? 0,
      dislikes: json['dislikes'] ?? 0,
      comments: json['comments'] ?? 0,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'likes': likes,
      'dislikes': dislikes,
      'comments': comments,
    };
  }
}

class UserInteractions {
  final List<UserNewsInteraction> likes;
  final List<UserNewsInteraction> dislikes;
  final List<UserComment> comments;

  UserInteractions({
    required this.likes,
    required this.dislikes,
    required this.comments,
  });

  factory UserInteractions.fromJson(Map<String, dynamic> json) {
    // Handle potential null values safely
    List<dynamic> likesList = json['likes'] is List ? json['likes'] : [];
    List<dynamic> dislikesList = json['dislikes'] is List ? json['dislikes'] : [];
    List<dynamic> commentsList = json['comments'] is List ? json['comments'] : [];

    return UserInteractions(
      likes: likesList.map((i) => UserNewsInteraction.fromJson(i as Map<String, dynamic>)).toList(),
      dislikes: dislikesList.map((i) => UserNewsInteraction.fromJson(i as Map<String, dynamic>)).toList(),
      comments: commentsList.map((i) => UserComment.fromJson(i as Map<String, dynamic>)).toList(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'likes': likes.map((i) => i.toJson()).toList(),
      'dislikes': dislikes.map((i) => i.toJson()).toList(),
      'comments': comments.map((i) => i.toJson()).toList(),
    };
  }
}

class UserNewsInteraction {
  final String id;
  final String title;
  final String category;
  final DateTime publishedAt;

  UserNewsInteraction({
    required this.id,
    required this.title,
    required this.category,
    required this.publishedAt,
  });

  factory UserNewsInteraction.fromJson(Map<String, dynamic> json) {
    // Handle potential null values for required String fields
    String id = json['id'] is String ? json['id'] : '';
    String title = json['title'] is String ? json['title'] : '';
    String category = json['category'] is String ? json['category'] : '';
    
    return UserNewsInteraction(
      id: id,
      title: title,
      category: category,
      publishedAt: json['publishedAt'] != null
          ? DateTime.parse(json['publishedAt'])
          : DateTime.now(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'title': title,
      'category': category,
      'publishedAt': publishedAt.toIso8601String(),
    };
  }
}

class UserComment {
  final String newsId;
  final String newsTitle;
  final String comment;
  final DateTime timestamp;

  UserComment({
    required this.newsId,
    required this.newsTitle,
    required this.comment,
    required this.timestamp,
  });

  factory UserComment.fromJson(Map<String, dynamic> json) {
    // Handle potential null values for required String fields
    String newsId = json['newsId'] is String ? json['newsId'] : '';
    String newsTitle = json['newsTitle'] is String ? json['newsTitle'] : '';
    String comment = json['comment'] is String ? json['comment'] : '';
    
    return UserComment(
      newsId: newsId,
      newsTitle: newsTitle,
      comment: comment,
      timestamp: json['timestamp'] != null
          ? DateTime.parse(json['timestamp'])
          : DateTime.now(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'newsId': newsId,
      'newsTitle': newsTitle,
      'comment': comment,
      'timestamp': timestamp.toIso8601String(),
    };
  }
}