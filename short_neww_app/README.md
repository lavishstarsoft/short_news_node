# Short News App

A Flutter application for displaying short news articles.

## Getting Started

This project is a Flutter application for displaying news articles with Google Sign-In functionality.

### Prerequisites

- Flutter SDK
- Android Studio or VS Code
- Google Sign-In configuration

### Installation

1. Clone the repository
2. Run `flutter pub get`
3. Set up Google Sign-In (see below)

### Google Sign-In Setup

To get Google Sign-In working properly, you need to:

1. Register your app's SHA-1 fingerprint in the Firebase Console
2. Download the updated `google-services.json` file
3. Enable Google Sign-In in Firebase Authentication

For detailed instructions, see [GOOGLE_SIGN_IN_FIX.md](../GOOGLE_SIGN_IN_FIX.md)

### Running the App

```bash
flutter run
```

### Testing Google Sign-In

Navigate to the "Test Google Sign-In" screen from the home page to test the authentication flow.

### Troubleshooting

If you encounter `ApiException: 10` errors:
1. Check that your SHA-1 fingerprint is registered in Firebase Console
2. Verify that the package name matches between your app and Firebase configuration
3. Ensure Google Sign-In is enabled in Firebase Authentication
4. Use the Diagnostics screen to get more detailed error information