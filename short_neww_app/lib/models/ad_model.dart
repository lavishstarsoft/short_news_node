class AdModel {
  final String id;
  final String title;
  final String? content;
  final String imageUrl; // Kept for backward compatibility
  final List<String> imageUrls; // New field for multiple images
  final String? linkUrl;
  final int positionInterval;
  final DateTime createdAt;
  
  // Intelligent ad fields
  final int? maxViewsPerDay;
  final int? cooldownPeriodHours;
  final bool? frequencyControlEnabled;
  final bool? userBehaviorTrackingEnabled;
  
  // AdMob fields
  final bool? useAdMob;
  final String? adMobAppId;
  final String? adMobUnitId;

  AdModel({
    required this.id,
    required this.title,
    this.content,
    required this.imageUrl,
    required this.imageUrls,
    this.linkUrl,
    required this.positionInterval,
    required this.createdAt,
    this.maxViewsPerDay,
    this.cooldownPeriodHours,
    this.frequencyControlEnabled,
    this.userBehaviorTrackingEnabled,
    this.useAdMob,
    this.adMobAppId,
    this.adMobUnitId,
  });

  factory AdModel.fromJson(Map<String, dynamic> json) {
    // Handle potential null values for required String fields
    String id = json['id'] is String ? json['id'] : '';
    String title = json['title'] is String ? json['title'] : '';
    String imageUrl = json['imageUrl'] is String ? json['imageUrl'] : '';
    
    // Handle multiple images
    List<String> imageUrls = [];
    if (json['imageUrls'] is List) {
      imageUrls = (json['imageUrls'] as List)
          .map((item) => item.toString())
          .toList();
    } else if (json['imageUrl'] is String) {
      // Fallback to single image if imageUrls is not available
      imageUrls = [json['imageUrl'] as String];
    }
    
    int positionInterval = json['positionInterval'] is int ? json['positionInterval'] : 3;
    
    return AdModel(
      id: id,
      title: title,
      content: json['content'] is String ? json['content'] : null,
      imageUrl: imageUrl,
      imageUrls: imageUrls,
      linkUrl: json['linkUrl'] is String ? json['linkUrl'] : null,
      positionInterval: positionInterval,
      createdAt: json['createdAt'] != null 
          ? DateTime.parse(json['createdAt'] as String)
          : DateTime.now(),
      // Intelligent ad fields
      maxViewsPerDay: json['maxViewsPerDay'] is int ? json['maxViewsPerDay'] : null,
      cooldownPeriodHours: json['cooldownPeriodHours'] is int ? json['cooldownPeriodHours'] : null,
      frequencyControlEnabled: json['frequencyControlEnabled'] is bool ? json['frequencyControlEnabled'] : null,
      userBehaviorTrackingEnabled: json['userBehaviorTrackingEnabled'] is bool ? json['userBehaviorTrackingEnabled'] : null,
      // AdMob fields
      useAdMob: json['useAdMob'] is bool ? json['useAdMob'] : null,
      adMobAppId: json['adMobAppId'] is String ? json['adMobAppId'] : null,
      adMobUnitId: json['adMobUnitId'] is String ? json['adMobUnitId'] : null,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'title': title,
      'content': content,
      'imageUrl': imageUrl,
      'imageUrls': imageUrls,
      'linkUrl': linkUrl,
      'positionInterval': positionInterval,
      'createdAt': createdAt.toIso8601String(),
      // Intelligent ad fields
      'maxViewsPerDay': maxViewsPerDay,
      'cooldownPeriodHours': cooldownPeriodHours,
      'frequencyControlEnabled': frequencyControlEnabled,
      'userBehaviorTrackingEnabled': userBehaviorTrackingEnabled,
      // AdMob fields
      'useAdMob': useAdMob,
      'adMobAppId': adMobAppId,
      'adMobUnitId': adMobUnitId,
    };
  }
}