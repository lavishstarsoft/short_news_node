class Comment {
  final String id;
  final String userId;
  final String username;
  final String location;
  final String content;
  final String newsId;
  final DateTime createdAt;
  final List<Comment> replies;
  final int likeCount;
  bool isLiked;
  
  Comment({
    required this.id,
    required this.userId,
    required this.username,
    required this.location,
    required this.content,
    required this.newsId,
    required this.createdAt,
    this.replies = const [],
    this.likeCount = 0,
    this.isLiked = false,
  });

  factory Comment.fromJson(Map<String, dynamic> json) {
    return Comment(
      id: json['_id'] ?? json['id'] ?? '',
      userId: json['userId'] ?? '',
      username: json['username'] ?? '',
      location: json['location'] ?? '',
      content: json['content'] ?? '',
      newsId: json['newsId'] ?? '',
      createdAt: json['createdAt'] != null 
          ? DateTime.parse(json['createdAt']) 
          : DateTime.now(),
      replies: (json['replies'] as List<dynamic>?)
          ?.map((reply) => Comment.fromJson(reply))
          .toList() ?? [],
      likeCount: json['likeCount'] ?? 0,
      isLiked: json['isLiked'] ?? false,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'userId': userId,
      'username': username,
      'location': location,
      'content': content,
      'newsId': newsId,
      'createdAt': createdAt.toIso8601String(),
      'replies': replies.map((reply) => reply.toJson()).toList(),
      'likeCount': likeCount,
      'isLiked': isLiked,
    };
  }

  String get timeAgo {
    final now = DateTime.now();
    final difference = now.difference(createdAt);

    if (difference.inDays > 365) {
      return '${(difference.inDays / 365).floor()}y ago';
    } else if (difference.inDays > 30) {
      return '${(difference.inDays / 30).floor()}mo ago';
    } else if (difference.inDays > 0) {
      return '${difference.inDays}d ago';
    } else if (difference.inHours > 0) {
      return '${difference.inHours}h ago';
    } else if (difference.inMinutes > 0) {
      return '${difference.inMinutes}m ago';
    } else {
      return 'Just now';
    }
  }
}