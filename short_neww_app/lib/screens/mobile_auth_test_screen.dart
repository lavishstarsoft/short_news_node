import 'package:flutter/material.dart';
import 'package:short_neww_app/services/mobile_auth_service.dart';

class MobileAuthTestScreen extends StatefulWidget {
  const MobileAuthTestScreen({super.key});

  @override
  State<MobileAuthTestScreen> createState() => _MobileAuthTestScreenState();
}

class _MobileAuthTestScreenState extends State<MobileAuthTestScreen> {
  bool _isLoading = false;
  String _status = 'Not signed in';
  String _detailedStatus = '';

  @override
  void initState() {
    super.initState();
    _checkSignInStatus();
  }

  Future<void> _checkSignInStatus() async {
    final isSignedIn = MobileAuthService.isSignedIn;
    final user = MobileAuthService.currentUser;
    
    setState(() {
      _status = isSignedIn ? 'Signed in' : 'Not signed in';
      _detailedStatus = isSignedIn 
          ? 'User: ${user?.displayName ?? "No name"}\nMobile: ${user?.mobileNumber ?? "No mobile"}' 
          : 'No user currently signed in';
    });
  }

  Future<void> _register() async {
    setState(() {
      _isLoading = true;
      _status = 'Registering...';
      _detailedStatus = 'Attempting to register with mobile number';
    });

    try {
      final user = await MobileAuthService.register('9876543210', 'Test User');
      if (user != null) {
        setState(() {
          _status = 'Registered successfully';
          _detailedStatus = 'User: ${user.displayName}\nMobile: ${user.mobileNumber}\nID: ${user.userId}';
        });
      } else {
        setState(() {
          _status = 'Registration failed';
          _detailedStatus = 'No user returned from registration attempt';
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

  Future<void> _login() async {
    setState(() {
      _isLoading = true;
      _status = 'Logging in...';
      _detailedStatus = 'Attempting to login with mobile number';
    });

    try {
      final user = await MobileAuthService.login('9876543210');
      if (user != null) {
        setState(() {
          _status = 'Logged in successfully';
          _detailedStatus = 'User: ${user.displayName}\nMobile: ${user.mobileNumber}\nID: ${user.userId}';
        });
      } else {
        setState(() {
          _status = 'Login failed';
          _detailedStatus = 'No user returned from login attempt';
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
      await MobileAuthService.signOut();
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
        title: const Text('Mobile Auth Test'),
      ),
      body: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(
              'Auth Status: $_status',
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
                    onPressed: MobileAuthService.isSignedIn ? null : _register,
                    child: const Text('Register Test User'),
                  ),
                  const SizedBox(height: 10),
                  ElevatedButton(
                    onPressed: MobileAuthService.isSignedIn ? null : _login,
                    child: const Text('Login Test User'),
                  ),
                  const SizedBox(height: 10),
                  ElevatedButton(
                    onPressed: MobileAuthService.isSignedIn ? _signOut : null,
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