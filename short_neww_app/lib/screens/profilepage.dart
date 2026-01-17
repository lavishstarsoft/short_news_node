import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:short_neww_app/services/mobile_auth_service.dart';
import 'package:short_neww_app/services/news_api_service.dart';
import 'package:short_neww_app/models/user_model.dart';
import 'package:short_neww_app/screens/settings_page.dart'; // Import settings page

class ProfilePage extends StatefulWidget {
  const ProfilePage({super.key});

  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> {
  UserModel? _user;
  bool _isLoading = true;
  bool _isDarkMode = false;
  List<dynamic> _bookmarkedNews = [];

  @override
  void initState() {
    super.initState();
    _loadUserProfile();
    _loadPreferences();
    _loadBookmarkedNews();
  }

  Future<void> _loadPreferences() async {
    final prefs = await SharedPreferences.getInstance();
    setState(() {
      _isDarkMode = prefs.getBool('isDarkMode') ?? false;
    });
  }

  Future<void> _loadBookmarkedNews() async {
    final prefs = await SharedPreferences.getInstance();
    final bookmarkedIds = prefs.getStringList('bookmarkedNews') ?? [];
    
    // For now, we'll just store the IDs. In a real implementation, you might want to
    // fetch the full news objects from the API or database
    setState(() {
      _bookmarkedNews = bookmarkedIds;
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

  Future<void> _viewBookmarkedNews() async {
    final prefs = await SharedPreferences.getInstance();
    final bookmarkedIds = prefs.getStringList('bookmarkedNews') ?? [];
    
    if (bookmarkedIds.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No bookmarked news found')),
      );
      return;
    }
    
    // TODO: Navigate to a screen that shows bookmarked news
    // For now, just show a message with the count
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('You have ${bookmarkedIds.length} bookmarked news items')),
    );
  }

  Future<void> _loadUserProfile() async {
    setState(() {
      _isLoading = true;
    });

    try {
      final user = await NewsApiService.fetchUserProfile();
      if (mounted) {
        setState(() {
          _user = user;
          _isLoading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _isLoading = false;
        });
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error loading profile: $e')),
        );
      }
    }
  }

  Future<void> _signOut() async {
    // Sign out from mobile if signed in with mobile
    if (MobileAuthService.isSignedIn) {
      await MobileAuthService.signOut();
    }
    
    if (mounted) {
      // Navigate back to welcome screen
      Navigator.pushNamedAndRemoveUntil(context, '/welcome', (route) => false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Profile'),
        actions: [
          IconButton(
            onPressed: () {
              Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (context) => const SettingsPage(),
                ),
              );
            },
            icon: const Icon(Icons.settings),
          ),
          IconButton(
            onPressed: _signOut,
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _user == null
              ? const Center(child: Text('No user data available'))
              : SingleChildScrollView(
                  padding: const EdgeInsets.all(12.0), // Reduced padding
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // User info card with enhanced design
                      Card(
                        elevation: 2, // Reduced elevation
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12), // Reduced border radius
                        ),
                        child: Padding(
                          padding: const EdgeInsets.all(16.0), // Reduced padding
                          child: Column(
                            children: [
                              // Profile picture with better styling
                              Stack(
                                children: [
                                  CircleAvatar(
                                    radius: 50, // Reduced radius
                                    backgroundColor: Theme.of(context).primaryColor,
                                    child: CircleAvatar(
                                      radius: 45, // Reduced radius
                                      backgroundImage: _user!.photoUrl != null
                                          ? NetworkImage(_user!.photoUrl!)
                                          : null,
                                      child: _user!.photoUrl == null
                                          ? Icon(Icons.person, size: 40, color: Colors.grey[600]) // Reduced icon size
                                          : null,
                                    ),
                                  ),
                                  Positioned(
                                    bottom: 0,
                                    right: 0,
                                    child: Container(
                                      padding: const EdgeInsets.all(3), // Reduced padding
                                      decoration: BoxDecoration(
                                        color: Theme.of(context).primaryColor,
                                        shape: BoxShape.circle,
                                        border: Border.all(
                                          color: Colors.white,
                                          width: 2,
                                        ),
                                      ),
                                      child: const Icon(
                                        Icons.camera_alt,
                                        color: Colors.white,
                                        size: 14, // Reduced icon size
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 12), // Reduced spacing
                              
                              // User name with better styling
                              Text(
                                _user!.displayName,
                                style: const TextStyle(
                                  fontSize: 20, // Reduced font size
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                              const SizedBox(height: 4), // Reduced spacing
                              
                              // User email/mobile with better styling
                              Text(
                                _user!.email ?? _user!.mobileNumber ?? 'No contact info',
                                style: TextStyle(
                                  fontSize: 14, // Reduced font size
                                  color: Colors.grey[600],
                                ),
                              ),
                              const SizedBox(height: 12), // Reduced spacing
                              
                              // Member since info
                              Container(
                                padding: const EdgeInsets.all(8), // Reduced padding
                                decoration: BoxDecoration(
                                  color: Theme.of(context).primaryColor.withOpacity(0.1),
                                  borderRadius: BorderRadius.circular(8), // Reduced border radius
                                ),
                                child: Row(
                                  mainAxisAlignment: MainAxisAlignment.center,
                                  children: [
                                    const Icon(Icons.calendar_today, size: 16), // Reduced icon size
                                    const SizedBox(width: 6), // Reduced spacing
                                    Text(
                                      'Member since ${_user!.createdAt.day}/${_user!.createdAt.month}/${_user!.createdAt.year}',
                                      style: const TextStyle(
                                        fontSize: 12, // Reduced font size
                                        fontWeight: FontWeight.w500,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      
                      const SizedBox(height: 16), // Reduced spacing
                      
                      // Bookmarks and Settings section
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
                                'Quick Access',
                                style: TextStyle(
                                  fontSize: 18, // Reduced font size
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                              const SizedBox(height: 12), // Reduced spacing
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceAround,
                                children: [
                                  _buildQuickAccessItem(
                                    Icons.bookmark,
                                    'Bookmarks',
                                    '${_bookmarkedNews.length} items',
                                    _viewBookmarkedNews,
                                  ),
                                  _buildQuickAccessItem(
                                    Icons.settings,
                                    'Settings',
                                    'App preferences',
                                    () {
                                      Navigator.push(
                                        context,
                                        MaterialPageRoute(
                                          builder: (context) => const SettingsPage(),
                                        ),
                                      );
                                    },
                                  ),
                                ],
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

  Widget _buildStatItem(IconData icon, String label, int count, Color color) {
    return Column(
      children: [
        Container(
          padding: const EdgeInsets.all(10), // Reduced padding
          decoration: BoxDecoration(
            color: color.withOpacity(0.1),
            shape: BoxShape.circle,
          ),
          child: Icon(icon, size: 24, color: color), // Reduced icon size
        ),
        const SizedBox(height: 6), // Reduced spacing
        Text(
          '$count',
          style: const TextStyle(
            fontSize: 18, // Reduced font size
            fontWeight: FontWeight.bold
          ),
        ),
        Text(
          label, 
          style: const TextStyle(
            fontSize: 12, // Reduced font size
            fontWeight: FontWeight.w500,
          ),
        ),
      ],
    );
  }

  Widget _buildQuickAccessItem(IconData icon, String title, String subtitle, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Column(
        children: [
          Container(
            padding: const EdgeInsets.all(12), // Reduced padding
            decoration: BoxDecoration(
              color: Theme.of(context).primaryColor.withOpacity(0.1),
              shape: BoxShape.circle,
            ),
            child: Icon(icon, size: 24, color: Theme.of(context).primaryColor), // Reduced icon size
          ),
          const SizedBox(height: 6), // Reduced spacing
          Text(
            title,
            style: const TextStyle(
              fontSize: 14, // Reduced font size
              fontWeight: FontWeight.w600,
            ),
          ),
          Text(
            subtitle,
            style: TextStyle(
              fontSize: 10, // Reduced font size
              color: Colors.grey[600],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildInteractionList(String title, List<dynamic> items) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: const TextStyle(
            fontSize: 14, // Reduced font size
            fontWeight: FontWeight.bold
          ),
        ),
        const SizedBox(height: 6), // Reduced spacing
        if (items.isEmpty)
          const Padding(
            padding: EdgeInsets.all(12.0), // Reduced padding
            child: Text(
              'No interactions yet',
              style: TextStyle(
                fontSize: 12, // Reduced font size
                color: Colors.grey,
              ),
            ),
          )
        else
          Column(
            children: items.take(2).map((item) {
              return ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(
                  item.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                subtitle: Text(
                  '${item.category}',
                  style: TextStyle(
                    fontSize: 10, // Reduced font size
                    color: Colors.grey[600],
                  ),
                ),
                isThreeLine: false,
              );
            }).toList(),
          ),
      ],
    );
  }

  Widget _buildCommentList(String title, List<dynamic> comments) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: const TextStyle(
            fontSize: 14, // Reduced font size
            fontWeight: FontWeight.bold
          ),
        ),
        const SizedBox(height: 6), // Reduced spacing
        if (comments.isEmpty)
          const Padding(
            padding: EdgeInsets.all(12.0), // Reduced padding
            child: Text(
              'No comments yet',
              style: TextStyle(
                fontSize: 12, // Reduced font size
                color: Colors.grey,
              ),
            ),
          )
        else
          Column(
            children: comments.take(2).map((comment) {
              return ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(
                  comment.newsTitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                subtitle: Text(
                  comment.comment,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 10, // Reduced font size
                    color: Colors.grey[600],
                  ),
                ),
                isThreeLine: false,
              );
            }).toList(),
          ),
      ],
    );
  }
}