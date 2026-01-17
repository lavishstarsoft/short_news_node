import 'package:flutter_test/flutter_test.dart';
import 'package:short_neww_app/services/auth_service.dart';

void main() {
  group('Google Sign In Tests', () {
    test('AuthService should be initialized', () {
      // This is a simple test to verify the AuthService can be imported
      expect(AuthService, isNotNull);
    });

    test('AuthService should have signIn method', () {
      // This is a simple test to verify the AuthService has the signIn method
      expect(AuthService.signIn, isNotNull);
    });

    test('AuthService should have signOut method', () {
      // This is a simple test to verify the AuthService has the signOut method
      expect(AuthService.signOut, isNotNull);
    });

    test('User should not be signed in initially', () {
      // Initially, the user should not be signed in
      expect(AuthService.isSignedIn, false);
    });
  });
}