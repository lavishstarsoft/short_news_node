import 'package:flutter/material.dart';
import 'package:short_neww_app/services/auth_service.dart';

class AuthDiagnosticsScreen extends StatefulWidget {
  const AuthDiagnosticsScreen({super.key});

  @override
  State<AuthDiagnosticsScreen> createState() => _AuthDiagnosticsScreenState();
}

class _AuthDiagnosticsScreenState extends State<AuthDiagnosticsScreen> {
  bool _isLoading = false;
  List<String> _logs = [];
  String _currentStatus = 'Ready';

  void _log(String message) {
    setState(() {
      _logs.add('${DateTime.now().toString().split('.').first}: $message');
      _currentStatus = message;
    });
  }

  Future<void> _runDiagnostics() async {
    setState(() {
      _logs.clear();
      _isLoading = true;
    });

    _log('Starting authentication diagnostics...');

    try {
      // Check current status
      _log('Checking current authentication status...');
      final isSignedIn = AuthService.isSignedIn;
      _log('Current sign-in status: $isSignedIn');

      if (isSignedIn) {
        final user = AuthService.currentUser;
        _log('Current user: ${user?.displayName ?? "null"}');
        _log('User email: ${user?.email ?? "null"}');
        _log('User ID: ${user?.id ?? "null"}');
      }

      // Try to get auth token
      _log('Attempting to get auth token...');
      final token = await AuthService.getAuthToken();
      _log('Auth token obtained: ${token != null}');
      if (token != null) {
        _log('Token length: ${token.length}');
      }

      // We can't directly access private members, so we'll skip the silent sign in test here
      _log('Diagnostics completed successfully');
    } catch (e) {
      _log('Error during diagnostics: $e');
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  Future<void> _testSignIn() async {
    setState(() {
      _logs.clear();
      _isLoading = true;
    });

    _log('Starting sign-in test...');

    try {
      _log('Calling AuthService.signIn()...');
      final user = await AuthService.signIn();
      
      if (user != null) {
        _log('Sign in successful!');
        _log('User: ${user.displayName}');
        _log('Email: ${user.email}');
        _log('ID: ${user.id}');
        
        // Try to get auth token
        _log('Getting auth token...');
        final token = await AuthService.getAuthToken();
        _log('Token obtained: ${token != null}');
        if (token != null) {
          // Show first 50 characters of token
          int end = token.length < 50 ? token.length : 50;
          _log('Token preview: ${token.substring(0, end)}...');
        }
      } else {
        _log('Sign in returned null - user may have cancelled');
      }
    } catch (e) {
      _log('Sign in error: $e');
      _log('Error type: ${e.runtimeType}');
      
      // Provide specific error messages
      if (e.toString().contains('sign_in_canceled')) {
        _log('User canceled the sign in process');
      } else if (e.toString().contains('network_error')) {
        _log('Network error occurred during sign in');
      } else if (e.toString().contains('invalid_client')) {
        _log('Invalid client configuration - check your google-services.json file');
      } else if (e.toString().contains('DEVELOPER_ERROR')) {
        _log('Developer error - this usually indicates a configuration issue');
        _log('Check that your SHA-1 fingerprint is registered in Firebase');
      }
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Auth Diagnostics'),
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
      ),
      backgroundColor: Colors.black,
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16.0),
            child: Row(
              children: [
                Expanded(
                  child: ElevatedButton(
                    onPressed: _isLoading ? null : _runDiagnostics,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.blue,
                      foregroundColor: Colors.white,
                    ),
                    child: const Text('Run Diagnostics'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: ElevatedButton(
                    onPressed: _isLoading ? null : _testSignIn,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.green,
                      foregroundColor: Colors.white,
                    ),
                    child: const Text('Test Sign In'),
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16.0),
            child: Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.grey[900],
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                'Status: $_currentStatus',
                style: const TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
          ),
          const SizedBox(height: 10),
          if (_isLoading)
            const Padding(
              padding: EdgeInsets.all(16.0),
              child: CircularProgressIndicator(
                valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
              ),
            ),
          Expanded(
            child: ListView.builder(
              padding: const EdgeInsets.all(16.0),
              itemCount: _logs.length,
              itemBuilder: (context, index) {
                return Container(
                  margin: const EdgeInsets.only(bottom: 8),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: Colors.grey[800],
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    _logs[index],
                    style: const TextStyle(
                      color: Colors.white,
                      fontFamily: 'monospace',
                      fontSize: 12,
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}