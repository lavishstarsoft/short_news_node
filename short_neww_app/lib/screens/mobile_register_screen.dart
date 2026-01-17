import 'package:flutter/material.dart';
import 'package:short_neww_app/services/mobile_auth_service.dart';

class MobileRegisterScreen extends StatefulWidget {
  const MobileRegisterScreen({super.key});

  @override
  State<MobileRegisterScreen> createState() => _MobileRegisterScreenState();
}

class _MobileRegisterScreenState extends State<MobileRegisterScreen> {
  final _mobileController = TextEditingController();
  final _nameController = TextEditingController();
  final _formKey = GlobalKey<FormState>();
  bool _isLoading = false;
  String? _returnToNewsId; // Store the news ID to return to after registration

  @override
  void initState() {
    super.initState();
  }

  @override
  void dispose() {
    _mobileController.dispose();
    _nameController.dispose();
    super.dispose();
  }

  Future<void> _register() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() {
      _isLoading = true;
    });

    try {
      final user = await MobileAuthService.register(
        _mobileController.text.trim(),
        _nameController.text.trim(),
      );

      if (user != null) {
        if (mounted) {
          // Navigate back to the specific news item if returnToNewsId is provided,
          // otherwise go to home screen
          if (_returnToNewsId != null) {
            // Navigate back to home screen with the specific news ID
            Navigator.pushNamedAndRemoveUntil(
              context, 
              '/home', 
              (route) => false,
              arguments: {'scrollToNewsId': _returnToNewsId}
            );
          } else {
            // Navigate to home screen or main app
            Navigator.pushNamedAndRemoveUntil(context, '/home', (route) => false);
          }
        }
      } else {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Registration failed. Please try again.')),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error: $e')),
        );
      }
    } finally {
      if (mounted) {
        setState(() {
          _isLoading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    // Extract the returnToNewsId from route arguments if present
    final args = ModalRoute.of(context)?.settings.arguments as Map<String, dynamic>?;
    _returnToNewsId = args?['returnToNewsId'] as String?;
    
    return Scaffold(
      appBar: AppBar(
        title: const Text('Register with Mobile'),
      ),
      body: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Form(
          key: _formKey,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Text(
                'Enter your mobile number and name to register',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 30),
              TextFormField(
                controller: _mobileController,
                decoration: const InputDecoration(
                  labelText: 'Mobile Number',
                  hintText: 'Enter your 10-digit mobile number',
                  prefixText: '+91 ',
                  border: OutlineInputBorder(),
                ),
                keyboardType: TextInputType.phone,
                validator: (value) {
                  if (value == null || value.isEmpty) {
                    return 'Please enter your mobile number';
                  }
                  if (value.length != 10 || !RegExp(r'^[0-9]+$').hasMatch(value)) {
                    return 'Please enter a valid 10-digit mobile number';
                  }
                  return null;
                },
              ),
              const SizedBox(height: 20),
              TextFormField(
                controller: _nameController,
                decoration: const InputDecoration(
                  labelText: 'Full Name',
                  hintText: 'Enter your full name',
                  border: OutlineInputBorder(),
                ),
                validator: (value) {
                  if (value == null || value.isEmpty) {
                    return 'Please enter your name';
                  }
                  if (value.length < 2) {
                    return 'Name should be at least 2 characters';
                  }
                  return null;
                },
              ),
              const SizedBox(height: 30),
              SizedBox(
                width: double.infinity,
                height: 50,
                child: ElevatedButton(
                  onPressed: _isLoading ? null : _register,
                  child: _isLoading
                      ? const CircularProgressIndicator()
                      : const Text(
                          'Register',
                          style: TextStyle(fontSize: 18),
                        ),
                ),
              ),
              const SizedBox(height: 20),
              TextButton(
                onPressed: () {
                  // Pass the returnToNewsId to the login screen if present
                  if (_returnToNewsId != null) {
                    Navigator.pushNamed(
                      context, 
                      '/mobile-login',
                      arguments: {'returnToNewsId': _returnToNewsId}
                    );
                  } else {
                    Navigator.pop(context);
                  }
                },
                child: const Text('Already have an account? Login'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}