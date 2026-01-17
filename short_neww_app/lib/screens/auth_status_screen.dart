import 'package:flutter/material.dart';
import 'package:short_neww_app/services/auth_service.dart';

class AuthStatusScreen extends StatefulWidget {
  const AuthStatusScreen({super.key});

  @override
  State<AuthStatusScreen> createState() => _AuthStatusScreenState();
}

class _AuthStatusScreenState extends State<AuthStatusScreen> {
  bool _isLoading = false;
  String _status = '';
  String _detailedStatus = '';

  @override
  void initState() {
    super.initState();
    _checkAuthStatus();
  }

  Future<void> _checkAuthStatus() async {
    setState(() {
      _isLoading = true;
      _status = 'Checking authentication...';
      _detailedStatus = 'Please wait while we check your authentication status';
    });

    try {
      final isSignedIn = AuthService.isSignedIn;
      final user = AuthService.currentUser;
      
      if (isSignedIn && user != null) {
        setState(() {
          _status = 'Authenticated';
          _detailedStatus = 
              'User: ${user.displayName ?? "No name"}\n'
              'Email: ${user.email ?? "No email"}\n'
              'ID: ${user.id}\n'
              'Photo URL: ${user.photoUrl ?? "No photo"}';
        });
      } else {
        // Try silent sign in
        final signedInUser = await AuthService.signIn();
        if (signedInUser != null) {
          setState(() {
            _status = 'Authenticated';
            _detailedStatus = 
                'User: ${signedInUser.displayName ?? "No name"}\n'
                'Email: ${signedInUser.email ?? "No email"}\n'
                'ID: ${signedInUser.id}\n'
                'Photo URL: ${signedInUser.photoUrl ?? "No photo"}';
          });
        } else {
          setState(() {
            _status = 'Not Authenticated';
            _detailedStatus = 'No user is currently signed in';
          });
        }
      }
    } catch (e) {
      setState(() {
        _status = 'Error';
        _detailedStatus = 'Error checking authentication: $e';
      });
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
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
          _detailedStatus = 
              'User: ${user.displayName}\n'
              'Email: ${user.email}\n'
              'ID: ${user.id}';
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
        _detailedStatus = 'Error during sign in: $e';
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
        title: const Text('Authentication Status'),
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
      ),
      backgroundColor: Colors.black,
      body: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(
              'Auth Status: $_status',
              style: const TextStyle(
                fontSize: 20, 
                fontWeight: FontWeight.bold,
                color: Colors.white,
              ),
            ),
            const SizedBox(height: 20),
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Colors.grey[900],
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                _detailedStatus,
                style: const TextStyle(
                  fontSize: 16,
                  color: Colors.white,
                ),
              ),
            ),
            const SizedBox(height: 30),
            if (_isLoading)
              const CircularProgressIndicator(
                valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
              )
            else
              Column(
                children: [
                  ElevatedButton(
                    onPressed: _signIn,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.blue,
                      foregroundColor: Colors.white,
                      minimumSize: const Size(double.infinity, 50),
                    ),
                    child: const Text('Sign In with Google'),
                  ),
                  const SizedBox(height: 10),
                  ElevatedButton(
                    onPressed: AuthService.isSignedIn ? _signOut : null,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.red,
                      foregroundColor: Colors.white,
                      minimumSize: const Size(double.infinity, 50),
                    ),
                    child: const Text('Sign Out'),
                  ),
                  const SizedBox(height: 10),
                  ElevatedButton(
                    onPressed: _checkAuthStatus,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.grey[700],
                      foregroundColor: Colors.white,
                      minimumSize: const Size(double.infinity, 50),
                    ),
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