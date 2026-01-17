import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key});

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  bool _isDarkMode = false;
  bool _notificationsEnabled = true;
  String _selectedLanguage = 'English';

  @override
  void initState() {
    super.initState();
    _loadSettings();
  }

  Future<void> _loadSettings() async {
    final prefs = await SharedPreferences.getInstance();
    setState(() {
      _isDarkMode = prefs.getBool('isDarkMode') ?? false;
      _notificationsEnabled = prefs.getBool('notificationsEnabled') ?? true;
      _selectedLanguage = prefs.getString('selectedLanguage') ?? 'English';
    });
  }

  Future<void> _toggleDarkMode(bool value) async {
    final prefs = await SharedPreferences.getInstance();
    setState(() {
      _isDarkMode = value;
    });
    await prefs.setBool('isDarkMode', value);
    
    // Notify the app to change theme
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(_isDarkMode ? 'Dark mode enabled' : 'Light mode enabled'),
        duration: Duration(seconds: 1),
      ),
    );
  }

  Future<void> _toggleNotifications(bool value) async {
    final prefs = await SharedPreferences.getInstance();
    setState(() {
      _notificationsEnabled = value;
    });
    await prefs.setBool('notificationsEnabled', value);
  }

  Future<void> _changeLanguage(String language) async {
    final prefs = await SharedPreferences.getInstance();
    setState(() {
      _selectedLanguage = language;
    });
    await prefs.setString('selectedLanguage', language);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Settings'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(12.0), // Reduced padding
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Appearance Section
            Card(
              elevation: 2, // Reduced elevation
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12), // Reduced border radius
              ),
              child: Padding(
                padding: const EdgeInsets.all(16.0), // Reduced padding
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Appearance',
                      style: TextStyle(
                        fontSize: 18, // Reduced font size
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 12), // Reduced spacing
                    ListTile(
                      leading: Icon(
                        _isDarkMode ? Icons.dark_mode : Icons.light_mode,
                        size: 24, // Reduced icon size
                      ),
                      title: const Text(
                        'Dark Mode',
                        style: TextStyle(
                          fontSize: 16, // Reduced font size
                        ),
                      ),
                      trailing: Switch(
                        value: _isDarkMode,
                        onChanged: _toggleDarkMode,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            
            const SizedBox(height: 16), // Reduced spacing
            
            // Notifications Section
            Card(
              elevation: 2, // Reduced elevation
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12), // Reduced border radius
              ),
              child: Padding(
                padding: const EdgeInsets.all(16.0), // Reduced padding
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Notifications',
                      style: TextStyle(
                        fontSize: 18, // Reduced font size
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 12), // Reduced spacing
                    ListTile(
                      leading: const Icon(
                        Icons.notifications,
                        size: 24, // Reduced icon size
                      ),
                      title: const Text(
                        'Enable Notifications',
                        style: TextStyle(
                          fontSize: 16, // Reduced font size
                        ),
                      ),
                      trailing: Switch(
                        value: _notificationsEnabled,
                        onChanged: _toggleNotifications,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            
            const SizedBox(height: 16), // Reduced spacing
            
            // Language Section
            Card(
              elevation: 2, // Reduced elevation
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12), // Reduced border radius
              ),
              child: Padding(
                padding: const EdgeInsets.all(16.0), // Reduced padding
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Language',
                      style: TextStyle(
                        fontSize: 18, // Reduced font size
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 12), // Reduced spacing
                    ListTile(
                      leading: const Icon(
                        Icons.language,
                        size: 24, // Reduced icon size
                      ),
                      title: const Text(
                        'App Language',
                        style: TextStyle(
                          fontSize: 16, // Reduced font size
                        ),
                      ),
                      subtitle: Text(
                        _selectedLanguage,
                        style: TextStyle(
                          fontSize: 14, // Reduced font size
                        ),
                      ),
                      onTap: () {
                        _showLanguageSelectionDialog();
                      },
                    ),
                  ],
                ),
              ),
            ),
            
            const SizedBox(height: 16), // Reduced spacing
            
            // About Section
            Card(
              elevation: 2, // Reduced elevation
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12), // Reduced border radius
              ),
              child: Padding(
                padding: const EdgeInsets.all(16.0), // Reduced padding
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'About',
                      style: TextStyle(
                        fontSize: 18, // Reduced font size
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 12), // Reduced spacing
                    ListTile(
                      leading: const Icon(
                        Icons.info,
                        size: 24, // Reduced icon size
                      ),
                      title: const Text(
                        'App Version',
                        style: TextStyle(
                          fontSize: 16, // Reduced font size
                        ),
                      ),
                      subtitle: const Text(
                        '1.0.0',
                        style: TextStyle(
                          fontSize: 14, // Reduced font size
                        ),
                      ),
                    ),
                    const Divider(),
                    ListTile(
                      leading: const Icon(
                        Icons.privacy_tip,
                        size: 24, // Reduced icon size
                      ),
                      title: const Text(
                        'Privacy Policy',
                        style: TextStyle(
                          fontSize: 16, // Reduced font size
                        ),
                      ),
                      onTap: () {
                        // TODO: Navigate to privacy policy
                      },
                    ),
                    const Divider(),
                    ListTile(
                      leading: const Icon(
                        Icons.description,
                        size: 24, // Reduced icon size
                      ),
                      title: const Text(
                        'Terms of Service',
                        style: TextStyle(
                          fontSize: 16, // Reduced font size
                        ),
                      ),
                      onTap: () {
                        // TODO: Navigate to terms of service
                      },
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _showLanguageSelectionDialog() {
    showDialog(
      context: context,
      builder: (BuildContext context) {
        return AlertDialog(
          title: const Text(
            'Select Language',
            style: TextStyle(
              fontSize: 18, // Reduced font size
            ),
          ),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                _buildLanguageOption('English', 'English'),
                _buildLanguageOption('తెలుగు', 'Telugu'),
                _buildLanguageOption('हिंदी', 'Hindi'),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _buildLanguageOption(String language, String code) {
    return RadioListTile(
      title: Text(
        language,
        style: TextStyle(
          fontSize: 16, // Reduced font size
        ),
      ),
      value: code,
      groupValue: _selectedLanguage,
      onChanged: (String? value) {
        if (value != null) {
          Navigator.of(context).pop();
          _changeLanguage(value);
        }
      },
    );
  }
}