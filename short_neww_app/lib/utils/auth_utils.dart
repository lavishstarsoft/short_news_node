import 'package:flutter/material.dart';
import '../widgets/authentication_bottom_sheet.dart';
import '../screens/mobile_login_screen.dart';

class AuthUtils {
  static Future<bool> showAuthBottomSheetIfNeeded(
    BuildContext context,
    bool isAuthenticated,
  ) async {
    if (isAuthenticated) {
      return true; // User is already authenticated
    }

    // Show the terms & conditions bottom sheet
    final result = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (context) => AuthenticationBottomSheet(),
    );

    // If user accepts the terms
    if (result == true) {
      if (!context.mounted) return false;
      
      // Navigate to login screen
      final loginResult = await Navigator.push(
        context,
        MaterialPageRoute(builder: (context) => MobileLoginScreen()),
      );

      // Return whether login was successful
      return loginResult == true;
    }

    return false; // User didn't accept or closed the sheet
  }
}