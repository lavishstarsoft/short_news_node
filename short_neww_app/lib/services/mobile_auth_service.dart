import 'dart:io' show Platform;
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart'; // Add this import
import 'package:permission_handler/permission_handler.dart'; // Add this import
import '../models/user_model.dart';

class MobileAuthService {
  static final MobileAuthService instance = MobileAuthService._();
  MobileAuthService._();

  static String get _baseUrl {
    // Use your machine's IP address for real device testing
    // Replace '192.168.0.127' with your actual machine IP address
    return 'https://shortnews-production.up.railway.app';
  }

  static UserModel? _currentUser;
  static String? _authToken;

  // Callback for when user logs in
  static Function(String userId)? _onUserLoggedIn;

  bool get isAuthenticated => _currentUser != null && _authToken != null;

  // Shared preferences keys
  static const String _prefsUserKey = 'mobile_user_data';
  static const String _prefsTokenKey = 'mobile_auth_token';

  // Get current user
  static UserModel? get currentUser => _currentUser;

  // Check if user is signed in
  static bool get isSignedIn => _currentUser != null && _authToken != null;

  // Set callback for when user logs in
  static void setOnUserLoggedIn(Function(String userId) callback) {
    _onUserLoggedIn = callback;
  }

  // Initialize authentication state from saved preferences
  static Future<void> initialize() async {
    print('=== Initializing Mobile Auth Service ===');
    try {
      final prefs = await SharedPreferences.getInstance();

      // Check if we have saved user data and token
      final savedUserJson = prefs.getString(_prefsUserKey);
      final savedToken = prefs.getString(_prefsTokenKey);

      if (savedUserJson != null && savedToken != null) {
        print('Found saved session data');
        final userMap = json.decode(savedUserJson);
        _currentUser = UserModel.fromJson(userMap);
        _authToken = savedToken;
        print('Restored user session for: ${_currentUser?.displayName}');
      } else {
        print('No saved session found');
      }
    } catch (error) {
      print('Error initializing auth service: $error');
      // Clear any corrupted data
      await _clearSavedData();
    }
  }

  // Save user data and token to shared preferences
  static Future<void> _saveSession() async {
    if (_currentUser != null && _authToken != null) {
      try {
        final prefs = await SharedPreferences.getInstance();
        final userJson = json.encode(_currentUser!.toJson());
        await prefs.setString(_prefsUserKey, userJson);
        await prefs.setString(_prefsTokenKey, _authToken!);
        print('Saved user session to preferences');
      } catch (error) {
        print('Error saving session: $error');
      }
    }
  }

  // Clear saved data from shared preferences
  static Future<void> _clearSavedData() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_prefsUserKey);
      await prefs.remove(_prefsTokenKey);
      print('Cleared saved session data');
    } catch (error) {
      print('Error clearing session data: $error');
    }
  }

  // Register with mobile number
  static Future<UserModel?> register(String mobileNumber, String name) async {
    try {
      print('=== Mobile Registration Process Started ===');
      print('Mobile Number: $mobileNumber');
      print('Name: $name');

      final response = await http.post(
        Uri.parse('$_baseUrl/api/public/auth/mobile/register'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'mobileNumber': mobileNumber, 'name': name}),
      );

      print('Registration response status: ${response.statusCode}');
      print('Registration response body: ${response.body}');

      if (response.statusCode == 201) {
        final Map<String, dynamic> userData = json.decode(response.body);
        _currentUser = UserModel.fromJson(userData);
        _authToken = userData['token'];
        // Save session data
        await _saveSession();
        print('Registration successful');
        print('User ID: ${_currentUser?.userId}');
        print('Display Name: ${_currentUser?.displayName}');

        // Request notification permission after successful registration
        await _requestNotificationPermission();

        // Notify that user has logged in
        if (_onUserLoggedIn != null && _currentUser?.userId != null) {
          _onUserLoggedIn!(_currentUser!.userId);
        }

        return _currentUser;
      } else {
        final Map<String, dynamic> errorData = json.decode(response.body);
        print('Registration failed: ${errorData['error']}');
        return null;
      }
    } catch (error) {
      print('Error during registration: $error');
      return null;
    }
  }

  // Login with mobile number
  static Future<UserModel?> login(String mobileNumber) async {
    try {
      print('=== Mobile Login Process Started ===');
      print('Mobile Number: $mobileNumber');

      final response = await http.post(
        Uri.parse('$_baseUrl/api/public/auth/mobile/login'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'mobileNumber': mobileNumber}),
      );

      print('Login response status: ${response.statusCode}');
      print('Login response body: ${response.body}');

      if (response.statusCode == 200) {
        final Map<String, dynamic> userData = json.decode(response.body);
        _currentUser = UserModel.fromJson(userData);
        _authToken = userData['token'];
        // Save session data
        await _saveSession();
        print('Login successful');
        print('User ID: ${_currentUser?.userId}');
        print('Display Name: ${_currentUser?.displayName}');

        // Request notification permission after successful login
        await _requestNotificationPermission();

        // Notify that user has logged in
        if (_onUserLoggedIn != null && _currentUser?.userId != null) {
          _onUserLoggedIn!(_currentUser!.userId);
        }

        return _currentUser;
      } else {
        final Map<String, dynamic> errorData = json.decode(response.body);
        print('Login failed: ${errorData['error']}');
        return null;
      }
    } catch (error) {
      print('Error during login: $error');
      return null;
    }
  }

  // Sign out
  static Future<void> signOut() async {
    print('=== Mobile Sign Out Process Started ===');
    _currentUser = null;
    _authToken = null;
    // Clear saved session data
    await _clearSavedData();
    print('Sign out successful');
  }

  // Get user ID
  static String? getUserId() {
    return _currentUser?.userId;
  }

  // Get user display name
  static String? getUserDisplayName() {
    return _currentUser?.displayName;
  }

  // Get user mobile number
  static String? getUserMobileNumber() {
    return _currentUser?.email?.replaceAll('@mobile.user', '');
  }

  // Get authentication token
  static String? getAuthToken() {
    return _authToken;
  }

  // Request notification permission
  static Future<void> _requestNotificationPermission() async {
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
}
