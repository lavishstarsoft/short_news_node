import 'dart:io' show Platform;
import 'package:socket_io_client/socket_io_client.dart' as io;

class WebSocketService {
  static io.Socket? _socket;
  static bool _initialized = false;
  static String? _userId;

  // Base URL for the admin backend WebSocket
  static String get baseUrl {
    // Use your machine's IP address for real device testing
    // Replace '192.168.0.127' with your actual machine IP address
    return 'https://shortnews-production.up.railway.app';
  }

  // Initialize WebSocket connection
  static void initialize(String userId) {
    print('Initializing WebSocket connection for user: $userId');
    print('WebSocket URL: $baseUrl');
    // Close existing connection if any
    if (_initialized) {
      print('Closing existing WebSocket connection');
      close();
    }

    _userId = userId;
    _socket = io.io(
      baseUrl,
      io.OptionBuilder()
          .setTransports(['websocket'])
          .enableAutoConnect()
          .build(),
    );

    _socket?.connect();
    _socket?.onConnect((_) {
      print('WebSocket connected successfully');
      // Register user with the server
      _socket?.emit('register', userId);
      print('Sent register event for user: $userId');
    });

    _socket?.onConnectError((err) {
      print('WebSocket connection error: $err');
    });

    _socket?.onError((err) {
      print('WebSocket error: $err');
    });

    _socket?.onDisconnect((_) => print('WebSocket disconnected'));
    _initialized = true;
  }

  // Reconnect WebSocket if needed
  static void reconnect(String userId) {
    print('Reconnecting WebSocket for user: $userId');
    if (_initialized && _userId != userId) {
      // User changed, reconnect with new user ID
      initialize(userId);
    } else if (!_initialized) {
      // Not initialized, initialize now
      initialize(userId);
    }
  }

  // Listen for new news notifications
  static void listenForNews(Function(dynamic) onNewsReceived) {
    if (!_initialized) {
      throw Exception('WebSocket not initialized. Call initialize() first.');
    }

    _socket?.on('new_news', (data) {
      print('New news received: $data');
      // Send acknowledgment to server
      if (_userId != null) {
        _socket?.emit('news_received', {
          'userId': _userId,
          'newsId': data['id'],
          'timestamp': DateTime.now().toIso8601String(),
        });
      }
      onNewsReceived(data);
    });
  }

  // Listen for admin notifications
  static void listenForAdminNotifications(
    Function(dynamic) onNotificationReceived,
  ) {
    if (!_initialized) {
      throw Exception('WebSocket not initialized. Call initialize() first.');
    }

    _socket?.on('admin_notification', (data) {
      print('Admin notification received: $data');
      // Send acknowledgment to server
      if (_userId != null) {
        _socket?.emit('notification_received', {
          'userId': _userId,
          'notificationId': data['id'] ?? data['_id'], // Handle both id and _id
          'timestamp': DateTime.now().toIso8601String(),
        });
      }
      onNotificationReceived(data);
    });
  }

  // Send notification opened acknowledgment
  static void sendNotificationOpened(String notificationId) {
    if (!_initialized) {
      throw Exception('WebSocket not initialized. Call initialize() first.');
    }

    if (_userId != null) {
      _socket?.emit('notification_opened', {
        'userId': _userId,
        'notificationId': notificationId,
        'timestamp': DateTime.now().toIso8601String(),
      });
      print(
        'Sent notification opened acknowledgment for notification: $notificationId',
      );
    }
  }

  // Check if WebSocket is connected
  static bool isConnected() {
    final connected = _initialized && _socket != null && _socket!.connected;
    print('WebSocket connection status: $connected');
    return connected;
  }

  // Close WebSocket connection
  static void close() {
    print('Closing WebSocket connection');
    _socket?.disconnect();
    _socket?.close();
    _initialized = false;
    _userId = null;
  }
}
