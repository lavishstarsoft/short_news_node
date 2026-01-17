import 'package:google_sign_in/google_sign_in.dart';
import 'package:flutter/services.dart';

class AuthService {
  static final GoogleSignIn _googleSignIn = GoogleSignIn(
    scopes: [
      'email',
      'profile'
    ],
    // Removed serverClientId as it's not needed for basic Google Sign-In
    // If you need to verify ID tokens on your backend, configure it properly there
  );

  static GoogleSignInAccount? _currentUser;

  // Get current user
  static GoogleSignInAccount? get currentUser => _currentUser;

  // Check if user is signed in
  static bool get isSignedIn => _currentUser != null;

  // Sign in with Google
  static Future<GoogleSignInAccount?> signIn() async {
    print('=== Google Sign In Process Started ===');
    try {
      print('Attempting silent sign in...');
      // Try to sign in silently first
      _currentUser = await _googleSignIn.signInSilently();
      print('Silent sign in result: ${_currentUser?.displayName ?? "null"}');
      if (_currentUser != null) {
        print('Silent sign in successful');
        return _currentUser;
      }
    } catch (silentError) {
      print('Silent sign in failed: $silentError');
      print('Error type: ${silentError.runtimeType}');
    }
    
    // If silent sign in fails or returns null, try interactive sign in
    try {
      print('Attempting interactive sign in...');
      _currentUser = await _googleSignIn.signIn();
      print('Interactive sign in result: ${_currentUser?.displayName ?? "null"}');
      if (_currentUser != null) {
        print('Interactive sign in successful');
        print('User details:');
        print('  Display Name: ${_currentUser?.displayName}');
        print('  Email: ${_currentUser?.email}');
        print('  ID: ${_currentUser?.id}');
        print('  Photo URL: ${_currentUser?.photoUrl}');
        return _currentUser;
      } else {
        print('Interactive sign in returned null');
        return null;
      }
    } catch (error) {
      print('Error during interactive sign in: $error');
      print('Error type: ${error.runtimeType}');
      // Handle specific error cases
      if (error.toString().contains('sign_in_canceled')) {
        print('User canceled the sign in');
      } else if (error.toString().contains('network_error')) {
        print('Network error occurred');
      } else if (error.toString().contains('invalid_client')) {
        print('Invalid client configuration - check your google-services.json file');
      } else if (error.toString().contains('DEVELOPER_ERROR')) {
        print('Developer error - check your Firebase configuration and SHA-1 fingerprint');
      } else if (error is PlatformException) {
        print('Platform exception: ${error.message}');
        print('Platform exception code: ${error.code}');
        // ApiException 10 usually means DEVELOPER_ERROR
        if (error.code == 'sign_in_failed') {
          print('This error (ApiException: 10) typically indicates a configuration issue.');
          print('Common causes:');
          print('1. Missing or incorrect SHA-1 fingerprint in Firebase console');
          print('2. Package name mismatch between app and Firebase configuration');
          print('3. Google Sign-In not enabled in Firebase console');
          print('4. Incorrect google-services.json file');
        }
      }
      return null;
    }
  }

  // Sign out
  static Future<void> signOut() async {
    print('=== Google Sign Out Process Started ===');
    try {
      await _googleSignIn.signOut();
      _currentUser = null;
      print('Sign out successful');
    } catch (error) {
      print('Error signing out: $error');
    }
  }

  // Get user ID
  static String? getUserId() {
    return _currentUser?.id;
  }

  // Get user email
  static String? getUserEmail() {
    return _currentUser?.email;
  }

  // Get user display name
  static String? getUserDisplayName() {
    return _currentUser?.displayName;
  }

  // Get user photo URL
  static String? getUserPhotoUrl() {
    return _currentUser?.photoUrl;
  }

  // Get authentication token
  static Future<String?> getAuthToken() async {
    print('=== Getting Auth Token ===');
    try {
      if (_currentUser == null) {
        print('No current user, cannot get auth token');
        return null;
      }
      print('Requesting authentication for user: ${_currentUser?.displayName}');
      final GoogleSignInAuthentication auth = await _currentUser!.authentication;
      print('Auth token obtained: ${auth.idToken != null}');
      if (auth.idToken != null) {
        print('ID Token length: ${auth.idToken!.length}');
      }
      if (auth.accessToken != null) {
        print('Access Token length: ${auth.accessToken!.length}');
      }
      return auth.idToken;
    } catch (error) {
      print('Error getting auth token: $error');
      print('Error type: ${error.runtimeType}');
      
      // Provide more specific error information
      if (error.toString().contains('DEVELOPER_ERROR')) {
        print('This error often occurs when the SHA-1 fingerprint is not registered in Firebase');
        print('or when the google-services.json file contains incorrect configuration');
      }
      
      return null;
    }
  }

  // Check if user is authenticated
  static Future<bool> isAuthenticated() async {
    print('=== Checking Authentication Status ===');
    try {
      _currentUser = await _googleSignIn.signInSilently();
      final isAuthenticated = _currentUser != null;
      print('Authentication status: $isAuthenticated');
      return isAuthenticated;
    } catch (error) {
      print('User not authenticated: $error');
      return false;
    }
  }
  
  // Force refresh authentication
  static Future<bool> forceRefreshAuth() async {
    print('=== Force Refreshing Authentication ===');
    try {
      // Sign out first to clear any cached state
      await _googleSignIn.signOut();
      _currentUser = null;
      
      // Then try to sign in again
      _currentUser = await _googleSignIn.signIn();
      final isAuthenticated = _currentUser != null;
      print('Force refresh result: $isAuthenticated');
      return isAuthenticated;
    } catch (error) {
      print('Error during force refresh: $error');
      return false;
    }
  }
}