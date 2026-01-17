import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter/material.dart';
import 'package:onesignal_flutter/onesignal_flutter.dart';
import 'package:url_launcher/url_launcher.dart';
import 'dart:convert';
import '../models/news_model.dart';

class NotificationService {
  static final NotificationService _instance = NotificationService._internal();
  factory NotificationService() => _instance;
  NotificationService._internal();

  final FlutterLocalNotificationsPlugin _notifications = FlutterLocalNotificationsPlugin();
  
  Future<void> initialize() async {
    // Initialize the plugin
    const AndroidInitializationSettings initializationSettingsAndroid =
        AndroidInitializationSettings('ic_stat_onesignal_default'); // Use OneSignal default icon
        
    final InitializationSettings initializationSettings = const InitializationSettings(
      android: initializationSettingsAndroid,
    );

    await _notifications.initialize(initializationSettings, onDidReceiveNotificationResponse: _onSelectNotification);
    
    // Initialize OneSignal
    await _initializeOneSignal();
  }
  
  Future<void> _initializeOneSignal() async {
    // Replace with your OneSignal App ID
    OneSignal.Debug.setLogLevel(OSLogLevel.verbose);
    OneSignal.initialize('bc75fbe4-22a7-4c53-ba97-f1c8c4ae89c0');
    
    // Configure OneSignal
    OneSignal.consentRequired(false);
    
    // Set up notification received handler
    OneSignal.Notifications.addForegroundWillDisplayListener((event) {
      print('OneSignal notification will display: ${event.notification.jsonRepresentation()}');
      // Show the notification
      _showOSNotification(event.notification);
      // Continue to show the notification
      // In v5, we don't need to call preventDefault for showing notifications
    });
    
    // Set up notification opened handler
    OneSignal.Notifications.addClickListener((event) {
      print('OneSignal notification opened: ${event.notification.jsonRepresentation()}');
      // Handle notification tap
      _handleOSNotificationTap(event.notification);
    });
  }
  
  // Show OneSignal notification
  Future<void> _showOSNotification(OSNotification notification) async {
    try {
      // Extract title color if provided in additional data
      String? titleColor;
      if (notification.additionalData != null && 
          notification.additionalData!['titleColor'] != null) {
        titleColor = notification.additionalData!['titleColor'].toString();
        print('Title color from OneSignal notification: $titleColor');
      }

      late AndroidNotificationDetails androidNotificationDetails;

      // Apply title color if provided
      if (titleColor != null && titleColor.isNotEmpty) {
        print('Applying title color from OneSignal: $titleColor');
        try {
          final color = _hexToColor(titleColor);
          print('Converted color: $color');
          androidNotificationDetails = AndroidNotificationDetails(
            'short_news_channel',
            'Short News Notifications',
            channelDescription: 'Channel for Short News app notifications',
            importance: Importance.max,
            priority: Priority.high,
            color: color,
            // Set the small icon for notifications
            icon: 'ic_stat_onesignal_default',
            // Fix LED settings for older Android versions
            ledColor: color,
            ledOnMs: 1000,
            ledOffMs: 1000,
            enableLights: true,
          );
        } catch (e) {
          print('Error applying title color from OneSignal: $e');
          // Fallback to default notification details
          androidNotificationDetails = const AndroidNotificationDetails(
            'short_news_channel',
            'Short News Notifications',
            channelDescription: 'Channel for Short News app notifications',
            importance: Importance.max,
            priority: Priority.high,
            // Set the small icon for notifications
            icon: 'ic_stat_onesignal_default',
            // Fix LED settings for older Android versions
            ledOnMs: 1000,
            ledOffMs: 1000,
          );
        }
      } else {
        print('No title color from OneSignal, using default');
        androidNotificationDetails = const AndroidNotificationDetails(
          'short_news_channel',
          'Short News Notifications',
          channelDescription: 'Channel for Short News app notifications',
          importance: Importance.max,
          priority: Priority.high,
          // Set the small icon for notifications
          icon: 'ic_stat_onesignal_default',
          // Fix LED settings for older Android versions
          ledOnMs: 1000,
          ledOffMs: 1000,
        );
      }

      final NotificationDetails notificationDetails =
          NotificationDetails(android: androidNotificationDetails);

      await _notifications.show(
        DateTime.now().millisecondsSinceEpoch.remainder(100000),
        notification.title ?? 'Short News',
        notification.body,
        notificationDetails,
        payload: notification.additionalData?.toString(),
      );
    } catch (e) {
      print('Error showing OneSignal notification: $e');
    }
  }
  
  // Handle OneSignal notification tap
  void _handleOSNotificationTap(OSNotification notification) {
    try {
      final data = notification.additionalData;
      if (data != null) {
        // Check if there's a launch URL
        if (data['launchUrl'] != null && data['launchUrl'].toString().isNotEmpty) {
          _launchURL(data['launchUrl'].toString());
          return;
        }
        
        // Check if it's a news notification
        if (data['type'] == 'news' && data['newsId'] != null) {
          // Convert data to NewsModel
          final newsData = {
            '_id': data['newsId'],
            'title': data['title'],
            'content': data['content'],
            'mediaUrl': data['mediaUrl'],
            'mediaType': data['mediaType'],
            'timestamp': DateTime.now().toIso8601String(),
          };
          
          final news = NewsModel.fromJson(newsData);
          if (_onNewsNotification != null) {
            _onNewsNotification!(news);
          }
        } 
        // Check if it's an admin notification
        else if (data['type'] == 'admin') {
          if (_onAdminNotification != null) {
            _onAdminNotification!(Map<String, dynamic>.from(data));
          }
        }
      }
    } catch (e) {
      print('Error handling OneSignal notification tap: $e');
    }
  }
  
  // Handle notification tap from local notifications
  void _onSelectNotification(NotificationResponse notificationResponse) {
    try {
      if (notificationResponse.payload != null) {
        // Parse the payload to get the launch URL or news ID
        final payload = notificationResponse.payload;
        
        // Try to parse as JSON first
        try {
          final data = jsonDecode(payload!);
          
          // Check if there's a launch URL
          if (data['launchUrl'] != null && data['launchUrl'].toString().isNotEmpty) {
            _launchURL(data['launchUrl'].toString());
            return;
          }
          
          // Check if there's a news ID for admin notifications
          if (data['newsId'] != null && data['newsId'].toString().isNotEmpty) {
            _navigateToNewsDetail(data['newsId'].toString());
            return;
          }
        } catch (e) {
          print('Error parsing payload as JSON: $e');
          // Fall back to simple string parsing
        }
        
        // Try to extract launch URL from payload string (old approach)
        if (payload!.contains('launchUrl')) {
          // Extract URL from payload string (this is a simplified approach)
          final start = payload.indexOf('launchUrl') + 12; // "launchUrl":"
          final end = payload.indexOf('"', start);
          if (start > 11 && end > start) {
            final url = payload.substring(start, end);
            if (url.isNotEmpty) {
              _launchURL(url);
              return;
            }
          }
        }
        
        // Try to extract news ID from payload string (old approach)
        if (payload.contains('newsId')) {
          // Extract news ID from payload string
          final start = payload.indexOf('newsId') + 9; // "newsId":"
          final end = payload.indexOf('"', start);
          if (start > 8 && end > start) {
            final newsId = payload.substring(start, end);
            if (newsId.isNotEmpty) {
              _navigateToNewsDetail(newsId);
              return;
            }
          }
        }
      }
    } catch (e) {
      print('Error handling local notification tap: $e');
    }
  }
  
  // Navigate to news detail page
  void _navigateToNewsDetail(String newsId) {
    // This would typically involve navigating to the news detail screen
    // For now, we'll just print the news ID
    print('Navigate to news detail page for news ID: $newsId');
    
    // In a real implementation, you would use a navigation service or 
    // callback to navigate to the news detail page
    // For example:
    // NavigationService.instance.navigateToNewsDetail(newsId);
  }
  
  // Launch URL function
  Future<void> _launchURL(String url) async {
    try {
      final uri = Uri.parse(url);
      if (await canLaunchUrl(uri)) {
        await launchUrl(uri);
      } else {
        print('Could not launch URL: $url');
      }
    } catch (e) {
      print('Error launching URL: $e');
    }
  }
  
  // Callback for when a new news notification is received
  Function(NewsModel)? _onNewsNotification;
  
  // Callback for when an admin notification is received
  Function(Map<String, dynamic>)? _onAdminNotification;

  // Handle new news notification (for WebSocket notifications)
  Future<void> showNewsNotification(NewsModel news) async {
    if (_onNewsNotification != null) {
      _onNewsNotification!(news);
    }

    const AndroidNotificationDetails androidNotificationDetails =
        AndroidNotificationDetails(
      'short_news_channel',
      'Short News Notifications',
      channelDescription: 'Channel for Short News app notifications',
      importance: Importance.max,
      priority: Priority.high,
      // Set the small icon for notifications
      icon: 'ic_stat_onesignal_default',
      // Fix LED settings for older Android versions
      ledOnMs: 1000,
      ledOffMs: 1000,
    );

    const NotificationDetails notificationDetails =
        NotificationDetails(android: androidNotificationDetails);

    await _notifications.show(
      DateTime.now().millisecondsSinceEpoch.remainder(100000),
      'New News: ${news.title}',
      news.content,
      notificationDetails,
    );
  }

  // Handle admin notification (for WebSocket notifications)
  Future<void> showAdminNotification(Map<String, dynamic> notification) async {
    if (_onAdminNotification != null) {
      _onAdminNotification!(notification);
    }

    // Extract title color if provided
    String? titleColor;
    if (notification['titleColor'] != null) {
      titleColor = notification['titleColor'].toString();
      print('Title color extracted: $titleColor');
    }

    late AndroidNotificationDetails androidNotificationDetails;

    // Apply title color if provided
    if (titleColor != null && titleColor.isNotEmpty) {
      print('Applying title color: $titleColor');
      try {
        final color = _hexToColor(titleColor);
        print('Converted color: $color');
        androidNotificationDetails = AndroidNotificationDetails(
          'short_news_channel',
          'Short News Notifications',
          channelDescription: 'Channel for Short News app notifications',
          importance: Importance.max,
          priority: Priority.high,
          color: color,
          // Set the small icon for notifications
          icon: 'ic_stat_onesignal_default',
          // Fix LED settings for older Android versions
          ledColor: color,
          ledOnMs: 1000,
          ledOffMs: 1000,
          enableLights: true,
        );
      } catch (e) {
        print('Error applying title color: $e');
        // Fallback to default notification details
        androidNotificationDetails = const AndroidNotificationDetails(
          'short_news_channel',
          'Short News Notifications',
          channelDescription: 'Channel for Short News app notifications',
          importance: Importance.max,
          priority: Priority.high,
          // Set the small icon for notifications
          icon: 'ic_stat_onesignal_default',
          // Fix LED settings for older Android versions
          ledOnMs: 1000,
          ledOffMs: 1000,
        );
      }
    } else {
      print('No title color provided, using default');
      androidNotificationDetails = const AndroidNotificationDetails(
        'short_news_channel',
        'Short News Notifications',
        channelDescription: 'Channel for Short News app notifications',
        importance: Importance.max,
        priority: Priority.high,
        // Set the small icon for notifications
        icon: 'ic_stat_onesignal_default',
        // Fix LED settings for older Android versions
        ledOnMs: 1000,
        ledOffMs: 1000,
      );
    }

    final NotificationDetails notificationDetails =
        NotificationDetails(android: androidNotificationDetails);

    // Create payload with both launchUrl and newsId if available
    String? payload;
    if (notification['launchUrl'] != null) {
      payload = '{"launchUrl":"${notification['launchUrl']}"}';
    } else if (notification['newsId'] != null) {
      payload = '{"newsId":"${notification['newsId']}"}';
    }

    await _notifications.show(
      DateTime.now().millisecondsSinceEpoch.remainder(100000),
      notification['title'] ?? 'Admin Notification',
      notification['message'] ?? '',
      notificationDetails,
      payload: payload,
    );
  }

  // Convert hex color string to Color object
  Color _hexToColor(String hexColor) {
    try {
      hexColor = hexColor.toUpperCase().replaceAll('#', '');
      if (hexColor.length == 6) {
        hexColor = 'FF' + hexColor; // Add alpha channel
      }
      return Color(int.parse(hexColor, radix: 16));
    } catch (e) {
      print('Error converting hex color $hexColor: $e');
      return Colors.black; // Default to black if conversion fails
    }
  }

  // Cancel all notifications
  Future<void> cancelAllNotifications() async {
    await _notifications.cancelAll();
  }

  // Register callback for news notifications
  void setOnNewsNotification(Function(NewsModel) callback) {
    _onNewsNotification = callback;
  }

  // Register callback for admin notifications
  void setOnAdminNotification(Function(Map<String, dynamic>) callback) {
    _onAdminNotification = callback;
  }
}