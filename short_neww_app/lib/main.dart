import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_native_splash/flutter_native_splash.dart';
import 'package:permission_handler/permission_handler.dart';
import 'screens/home_screen.dart';
import 'services/admob_service.dart';

import 'screens/profilepage.dart';
import 'screens/welcome_screen.dart';
import 'screens/mobile_login_screen.dart';
import 'screens/mobile_register_screen.dart';
import 'screens/mobile_auth_test_screen.dart'; // Add this import
import 'screens/settings_page.dart'; // Add this import
import 'services/mobile_auth_service.dart'; // Add this import
import 'services/websocket_service.dart'; // Add this import
import 'services/notification_service.dart'; // Add this import
import 'models/news_model.dart'; // Add this import
import 'services/news_api_service.dart'; // Add this import

// Request notification permission
Future<void> _requestNotificationPermission() async {
  try {
    // Check if notification permission is granted
    var status = await Permission.notification.status;

    // If not granted, request permission
    if (!status.isGranted) {
      await Permission.notification.request();
    }
  } catch (e) {
    print('Error requesting notification permission: $e');
  }
}

void main() async {
  WidgetsBinding widgetsBinding = WidgetsFlutterBinding.ensureInitialized();
  FlutterNativeSplash.preserve(widgetsBinding: widgetsBinding);

  // Initialize notification service
  await NotificationService().initialize();

  // Request notification permission on first app launch
  await _requestNotificationPermission();

  // Initialize Google Mobile Ads SDK using service
  try {
    await AdMobService.initialize();
  } catch (e) {
    debugPrint('Error initializing AdMob in main: $e');
  }

  // Set system overlay style for white status bar and navigation bar icons
  SystemChrome.setSystemUIOverlayStyle(
    SystemUiOverlayStyle.light.copyWith(
      statusBarColor: Colors.transparent, // Make status bar transparent
      systemNavigationBarColor: Colors.black, // Navigation bar background color
      systemNavigationBarIconBrightness:
          Brightness.light, // Navigation bar icons color
    ),
  );

  // --- Initialization Logic from SplashWrapper ---

  // Artificial delay if needed (can be removed if you want it faster)
  await Future.delayed(const Duration(seconds: 2));

  // Initialize authentication service to check for saved session
  await MobileAuthService.initialize();

  // Set up callback for when user logs in
  MobileAuthService.setOnUserLoggedIn((userId) {
    // Initialize WebSocket connection when user logs in
    _initializeWebSocketAndListeners(userId);
  });

  // Initialize WebSocket service if user is logged in
  if (MobileAuthService.isSignedIn) {
    final userId = MobileAuthService.getUserId();
    if (userId != null) {
      _initializeWebSocketAndListeners(userId);
    }
  } else {
    // For testing purposes, initialize WebSocket with a test user ID
    // In a real app, this would only happen after successful login
    _initializeWebSocketAndListeners('test_user_123');
  }

  runApp(const ShortNewsApp());

  // Remove native splash screen now that app is ready
  FlutterNativeSplash.remove();
}

// Helper function for WebSocket initialization
void _initializeWebSocketAndListeners(String userId) {
  WebSocketService.initialize(userId);

  // Listen for new news notifications
  WebSocketService.listenForNews((data) {
    // Convert the received data to a NewsModel
    final news = NewsModel.fromJson(data);

    // Show notification
    NotificationService().showNewsNotification(news);
  });

  // Listen for admin notifications
  WebSocketService.listenForAdminNotifications((data) {
    // Show admin notification
    NotificationService().showAdminNotification(data);
  });
}

class ShortNewsApp extends StatelessWidget {
  const ShortNewsApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Short News',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        primarySwatch: Colors.blue,
        useMaterial3: true,
        fontFamily: 'TeluguFont',
        appBarTheme: const AppBarTheme(
          systemOverlayStyle: SystemUiOverlayStyle.light,
        ),
      ),
      // Directly go to HomeScreen as Native Splash covers the loading time
      home: const HomeScreen(),
      routes: {
        '/home': (context) => const HomeScreen(),
        '/profile': (context) => const ProfilePage(),
        '/welcome': (context) => const WelcomeScreen(),
        '/mobile-login': (context) => const MobileLoginScreen(),
        '/mobile-register': (context) => const MobileRegisterScreen(),
        '/mobile-auth-test': (context) => const MobileAuthTestScreen(),
        '/settings': (context) => const SettingsPage(),
      },
    );
  }
}
