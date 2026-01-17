import 'package:flutter/material.dart';
import 'package:short_neww_app/services/auth_service.dart';
import 'dart:io' show Platform;

class SignInDiagnosticsScreen extends StatefulWidget {
  const SignInDiagnosticsScreen({super.key});

  @override
  State<SignInDiagnosticsScreen> createState() => _SignInDiagnosticsScreenState();
}

class _SignInDiagnosticsScreenState extends State<SignInDiagnosticsScreen> {
  bool _isLoading = false;
  List<String> _diagnosticsLog = [];
  bool _isSignedIn = false;

  @override
  void initState() {
    super.initState();
    _checkInitialStatus();
  }

  Future<void> _checkInitialStatus() async {
    final isSignedIn = AuthService.isSignedIn;
    setState(() {
      _isSignedIn = isSignedIn;
    });
  }

  void _logMessage(String message) {
    setState(() {
      _diagnosticsLog.add('[$currentTime] $message');
    });
    // Also print to console for easier debugging
    print(message);
  }

  String get currentTime {
    final now = DateTime.now();
    return '${now.hour}:${now.minute.toString().padLeft(2, '0')}:${now.second.toString().padLeft(2, '0')}';
  }

  Future<void> _runFullDiagnostics() async {
    setState(() {
      _isLoading = true;
      _diagnosticsLog.clear();
    });

    _logMessage('=== Starting Google Sign-In Diagnostics ===');
    
    // Platform information
    _logMessage('Platform: ${Platform.operatingSystem}');
    _logMessage('Package name: com.example.short_neww_app');
    
    // Current sign-in status
    _logMessage('Current sign-in status: ${AuthService.isSignedIn ? "Signed In" : "Not Signed In"}');
    
    if (AuthService.isSignedIn) {
      final user = AuthService.currentUser;
      _logMessage('Current user: ${user?.displayName ?? "Unknown"}');
      _logMessage('User email: ${user?.email ?? "Unknown"}');
    }
    
    // Test silent sign-in
    _logMessage('Testing silent sign-in...');
    try {
      final user = await AuthService.signIn();
      if (user != null) {
        _logMessage('Silent sign-in SUCCESSFUL');
        _logMessage('User: ${user.displayName}');
        _logMessage('Email: ${user.email}');
      } else {
        _logMessage('Silent sign-in returned NULL (not necessarily an error)');
      }
    } catch (e) {
      _logMessage('Silent sign-in FAILED: $e');
    }
    
    setState(() {
      _isLoading = false;
      _isSignedIn = AuthService.isSignedIn;
    });
    
    _logMessage('=== Diagnostics Complete ===');
  }

  Future<void> _attemptSignIn() async {
    setState(() {
      _isLoading = true;
    });

    _logMessage('=== Manual Sign-In Attempt ===');
    
    try {
      final user = await AuthService.signIn();
      if (user != null) {
        _logMessage('Sign-in SUCCESSFUL');
        _logMessage('User: ${user.displayName}');
        _logMessage('Email: ${user.email}');
      } else {
        _logMessage('Sign-in returned NULL');
      }
    } catch (e) {
      _logMessage('Sign-in FAILED: $e');
      _logMessage('Error type: ${e.runtimeType}');
    }
    
    setState(() {
      _isLoading = false;
      _isSignedIn = AuthService.isSignedIn;
    });
  }

  Future<void> _signOut() async {
    setState(() {
      _isLoading = true;
    });

    _logMessage('=== Sign-Out Attempt ===');
    
    try {
      await AuthService.signOut();
      _logMessage('Sign-out SUCCESSFUL');
    } catch (e) {
      _logMessage('Sign-out FAILED: $e');
    }
    
    setState(() {
      _isLoading = false;
      _isSignedIn = AuthService.isSignedIn;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Sign-In Diagnostics'),
      ),
      body: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16.0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Diagnostics Status',
                      style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                    ),
                    const SizedBox(height: 10),
                    Text('Signed In: ${_isSignedIn ? "Yes" : "No"}'),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                          child: ElevatedButton(
                            onPressed: _isLoading ? null : _runFullDiagnostics,
                            child: const Text('Run Full Diagnostics'),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: ElevatedButton(
                            onPressed: _isLoading ? null : _attemptSignIn,
                            child: const Text('Sign In'),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: ElevatedButton(
                            onPressed: _isLoading || !_isSignedIn ? null : _signOut,
                            child: const Text('Sign Out'),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 20),
            const Text(
              'Diagnostics Log:',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 10),
            Expanded(
              child: Container(
                decoration: BoxDecoration(
                  border: Border.all(color: Colors.grey),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: ListView.builder(
                  itemCount: _diagnosticsLog.length,
                  itemBuilder: (context, index) {
                    return Padding(
                      padding: const EdgeInsets.all(8.0),
                      child: Text(_diagnosticsLog[index]),
                    );
                  },
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}