import 'package:flutter/material.dart';
import 'package:short_neww_app/services/mobile_auth_service.dart';

class WelcomeScreen extends StatefulWidget {
  const WelcomeScreen({super.key});

  @override
  State<WelcomeScreen> createState() => _WelcomeScreenState();
}

class _WelcomeScreenState extends State<WelcomeScreen> {
  bool _isLoading = false;
  String? _returnToNewsId; // Store the news ID to return to after login

  @override
  void initState() {
    super.initState();
  }

  @override
  Widget build(BuildContext context) {
    // Extract the returnToNewsId from route arguments if present
    final args = ModalRoute.of(context)?.settings.arguments as Map<String, dynamic>?;
    _returnToNewsId = args?['returnToNewsId'] as String?;
    
    return Scaffold(
      body: Container(
        width: double.infinity,
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Colors.blue, Colors.purple],
          ),
        ),
        child: Stack(
          children: [
            // Skip button at top right
            Positioned(
              top: 50,
              right: 20,
              child: ElevatedButton(
                onPressed: () {
                  Navigator.pushNamedAndRemoveUntil(context, '/home', (route) => false);
                },
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.white.withOpacity(0.2),
                  foregroundColor: Colors.white,
                  side: const BorderSide(color: Colors.white, width: 1),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(20),
                  ),
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                ),
                child: const Text(
                  'Skip',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
            ),
            // Main content centered
            Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Text(
                    'Short News',
                    style: TextStyle(
                      fontSize: 40,
                      fontWeight: FontWeight.bold,
                      color: Colors.white,
                    ),
                  ),
                  const SizedBox(height: 10),
                  const Text(
                    'Stay updated with the latest news',
                    style: TextStyle(
                      fontSize: 16,
                      color: Colors.white70,
                    ),
                  ),
                  const SizedBox(height: 50),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 30),
                    child: Column(
                      children: [
                       
                        SizedBox(
                          width: double.infinity,
                          height: 50,
                          child: ElevatedButton.icon(
                            onPressed: _isLoading
                                ? null
                                : () {
                                    // Pass the returnToNewsId to the login screen
                                    if (_returnToNewsId != null) {
                                      Navigator.pushNamed(
                                        context, 
                                        '/mobile-login',
                                        arguments: {'returnToNewsId': _returnToNewsId}
                                      );
                                    } else {
                                      Navigator.pushNamed(context, '/mobile-login');
                                    }
                                  },
                            icon: const Icon(Icons.phone_android),
                            label: const Text(
                              'Sign in with Mobile',
                              style: TextStyle(fontSize: 16),
                            ),
                            style: ElevatedButton.styleFrom(
                              backgroundColor: Colors.white,
                              foregroundColor: Colors.black,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(10),
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(height: 20),
                        SizedBox(
                          width: double.infinity,
                          height: 50,
                          child: OutlinedButton(
                            onPressed: _isLoading
                                ? null
                                : () {
                                    // Pass the returnToNewsId to the register screen
                                    if (_returnToNewsId != null) {
                                      Navigator.pushNamed(
                                        context, 
                                        '/mobile-register',
                                        arguments: {'returnToNewsId': _returnToNewsId}
                                      );
                                    } else {
                                      Navigator.pushNamed(context, '/mobile-register');
                                    }
                                  },
                            child: const Text(
                              'Register with Mobile',
                              style: TextStyle(
                                fontSize: 16,
                                color: Colors.white,
                              ),
                            ),
                            style: OutlinedButton.styleFrom(
                              side: const BorderSide(color: Colors.white),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(10),
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}