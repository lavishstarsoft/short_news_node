import 'package:flutter/material.dart';
import 'package:short_neww_app/services/auth_service.dart';

class GoogleSignInTestScreen extends StatefulWidget {
  const GoogleSignInTestScreen({super.key});

  @override
  State<GoogleSignInTestScreen> createState() => _GoogleSignInTestScreenState();
}

class _GoogleSignInTestScreenState extends State<GoogleSignInTestScreen> {
  bool _isLoading = false;
  String _status = 'Not signed in';
  String _detailedStatus = '';

  @override
  void initState() {
    super.initState();
    _checkSignInStatus();
  }

  Future<void> _checkSignInStatus() async {
    final isSignedIn = AuthService.isSignedIn;
    final user = AuthService.currentUser;
    
    setState(() {
      _status = isSignedIn ? 'Signed in' : 'Not signed in';
      _detailedStatus = isSignedIn 
          ? 'User: ${user?.displayName ?? "No name"}\nEmail: ${user?.email ?? "No email"}' 
          : 'No user currently signed in';
    });
  }

  Future<void> _signIn() async {
    setState(() {
      _isLoading = true;
      _status = 'Signing in...';
      _detailedStatus = 'Attempting to sign in with Google';
    });

    try {
      final user = await AuthService.signIn();
      if (user != null) {
        setState(() {
          _status = 'Signed in successfully';
          _detailedStatus = 'User: ${user.displayName}\nEmail: ${user.email}\nID: ${user.id}';
        });
      } else {
        setState(() {
          _status = 'Sign in failed';
          _detailedStatus = 'No user returned from sign in attempt';
        });
      }
    } catch (e) {
      setState(() {
        _status = 'Error occurred';
        _detailedStatus = 'Error: $e';
      });
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  Future<void> _signOut() async {
    setState(() {
      _isLoading = true;
      _status = 'Signing out...';
      _detailedStatus = 'Attempting to sign out';
    });

    try {
      await AuthService.signOut();
      setState(() {
        _status = 'Signed out';
        _detailedStatus = 'User has been signed out successfully';
      });
    } catch (e) {
      setState(() {
        _status = 'Error occurred';
        _detailedStatus = 'Error during sign out: $e';
      });
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
        title: const Text('Google Sign-In Test'),
      ),
      body: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(
              'Sign-In Status: $_status',
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 10),
            Text(
              _detailedStatus,
              style: const TextStyle(fontSize: 14),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 20),
            if (_isLoading)
              const CircularProgressIndicator()
            else
              Column(
                children: [
                  ElevatedButton(
                    onPressed: AuthService.isSignedIn ? null : _signIn,
                    child: const Text('Sign In with Google'),
                  ),
                  const SizedBox(height: 10),
                  ElevatedButton(
                    onPressed: AuthService.isSignedIn ? _signOut : null,
                    child: const Text('Sign Out'),
                  ),
                  const SizedBox(height: 10),
                  ElevatedButton(
                    onPressed: _checkSignInStatus,
                    child: const Text('Refresh Status'),
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}