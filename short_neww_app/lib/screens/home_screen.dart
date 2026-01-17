import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'dart:async';
import '../models/news_model.dart';
import '../models/ad_model.dart';
import '../data/sample_news_data.dart';
import '../widgets/news_card.dart';
import '../widgets/shimmer_news_card.dart';
import '../widgets/ad_card.dart';
import '../services/graphql_service.dart';
import '../services/news_api_service.dart'; // Fallback for when GraphQL is unavailable
import '../services/ad_api_service.dart';
import '../services/auth_service.dart';
import '../services/database_service.dart';
import '../services/intelligent_ad_service.dart'; // Added import for intelligent ad service
import './unread_news_screen.dart';
import '../widgets/admob_card.dart'; // Add this import

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late PageController _pageController;
  List<NewsModel> newsList = [];
  List<NewsModel> allNewsList = [];
  List<AdModel> adsList = [];
  List<AdModel> filteredAdsList = []; // Added for intelligent ad filtering
  int currentIndex = 0;
  bool isLoading = true;
  bool isRefreshing = false;
  String? errorMessage;
  String selectedLocation = 'All';
  Timer? _refreshTimer;
  int unreadNewsCount = 0;
  int _previousNewsCount = 0;
  Set<String> recentlySeenAds = <String>{}; // Track recently seen ads
  Map<String, int> adViewCounts = <String, int>{}; // Track ad view counts
  String apiSource =
      'Unknown'; // Track which API is being used: 'GraphQL' or 'REST'

  @override
  void initState() {
    super.initState();
    _pageController = PageController();
    _loadNews();
    _loadUnreadNewsCount();

    // Set up periodic refresh every 30 seconds
    _refreshTimer = Timer.periodic(Duration(seconds: 30), (timer) {
      _refreshNews();
      _loadUnreadNewsCount();
    });

    // Ensure status bar and navigation bar icons are white
    SystemChrome.setSystemUIOverlayStyle(
      SystemUiOverlayStyle.light.copyWith(
        statusBarColor: Colors.transparent,
        systemNavigationBarColor: Colors.black,
        systemNavigationBarIconBrightness: Brightness.light,
      ),
    );
  }

  Future<void> _loadUnreadNewsCount() async {
    try {
      final count = await DatabaseService.getUnreadNewsCount();
      if (mounted) {
        setState(() {
          unreadNewsCount = count;
        });
      }
    } catch (e) {
      print('Error loading unread news count: $e');
    }
  }

  Future<void> _loadNews() async {
    try {
      setState(() {
        isLoading = true;
        errorMessage = null;
      });

      List<NewsModel> news;
      List<AdModel> ads = [];

      // Try GraphQL first, fallback to REST API if it fails
      try {
        if (selectedLocation == 'All') {
          final newsData = await GraphQLService.getNews(limit: 100);
          news = newsData.map((item) => NewsModel.fromJson(item)).toList();
        } else {
          final newsData = await GraphQLService.getNews(
            limit: 100,
            location: selectedLocation,
          );
          news = newsData.map((item) => NewsModel.fromJson(item)).toList();
        }
        print('✅ Successfully loaded news using GraphQL');
        setState(() {
          apiSource = 'GraphQL';
        });
      } catch (graphqlError) {
        print('❌ GraphQL failed, falling back to REST API: $graphqlError');
        // Fallback to REST API
        if (selectedLocation == 'All') {
          news = await NewsApiService.fetchNews();
        } else {
          news = await NewsApiService.fetchNewsByLocation(selectedLocation);
        }
        print('✅ Successfully loaded news using REST API');
        setState(() {
          apiSource = 'REST API';
        });
      }

      // Fetch ads
      ads = await AdApiService.fetchAds();

      // Update ad frequency settings from backend
      for (final ad in ads) {
        await IntelligentAdService.updateAdFrequencySettingsFromBackend(ad);
      }

      // Filter ads intelligently using the new service
      ads = await IntelligentAdService.filterAdsIntelligently(ads);

      // Sort by publishedAt descending (newest first) - Scenario 2
      news.sort((a, b) => b.publishedAt.compareTo(a.publishedAt));

      // Debug: Print first 3 news items to verify sorting
      print('📰 News sorted by publishedAt (newest first):');
      for (int i = 0; i < (news.length > 3 ? 3 : news.length); i++) {
        print(
          '  ${i + 1}. ${news[i].title.substring(0, news[i].title.length > 30 ? 30 : news[i].title.length)}... - ${news[i].publishedAt}',
        );
      }
      print('📊 Total news items: ${news.length}');

      // Save all news to database
      await DatabaseService.saveAllNews(news);

      // Load unread count after saving news
      _loadUnreadNewsCount();

      setState(() {
        allNewsList = selectedLocation == 'All' ? news : allNewsList;
        newsList = news;
        adsList = ads;
        filteredAdsList = ads; // Update filtered ads list
        isLoading = false;
        // Scenario 2: Set current index to 0 to show latest news first on fresh launch
        currentIndex = 0;
      });

      print('✅ Set currentIndex to 0 (latest news)');
      print(
        '📱 First news to display: ${news.isNotEmpty ? news[0].title.substring(0, news[0].title.length > 50 ? 50 : news[0].title.length) : "No news"}',
      );

      // Move page controller to first item after load
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_pageController.hasClients) {
          _pageController.jumpToPage(0);
          print('📄 PageController jumped to page 0');
        }
      });
    } catch (e) {
      setState(() {
        errorMessage = e.toString();
        isLoading = false;
        // Fallback to sample data if API fails
        allNewsList = SampleNewsData.getNewsList();
        newsList =
            selectedLocation == 'All'
                  ? allNewsList
                  : allNewsList
                      .where((item) => item.location == selectedLocation)
                      .toList()
              ..sort((a, b) => b.publishedAt.compareTo(a.publishedAt));
        // Set current index to 0 for sample data
        currentIndex = 0;
      });

      // Move page controller to first item after load
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_pageController.hasClients) {
          _pageController.jumpToPage(0);
        }
      });
    }
  }

  // Filter ads based on user behavior to avoid repetition
  Future<List<AdModel>> _filterAdsBasedOnUserBehavior(List<AdModel> ads) async {
    // Use the intelligent ad service for filtering
    return await IntelligentAdService.filterAdsIntelligently(ads);
  }

  Future<void> _refreshNews() async {
    // Prevent multiple simultaneous refreshes
    if (isRefreshing) return;

    try {
      setState(() {
        isRefreshing = true;
      });

      List<NewsModel> news;
      List<AdModel> ads = [];

      // Try GraphQL first, fallback to REST API if it fails
      try {
        if (selectedLocation == 'All') {
          final newsData = await GraphQLService.refetchNews(limit: 100);
          news = newsData.map((item) => NewsModel.fromJson(item)).toList();
        } else {
          final newsData = await GraphQLService.refetchNews(
            limit: 100,
            location: selectedLocation,
          );
          news = newsData.map((item) => NewsModel.fromJson(item)).toList();
        }
        print(
          '🔄 Auto-refresh: Successfully loaded fresh news using GraphQL (cache cleared)',
        );
      } catch (graphqlError) {
        print(
          '🔄 Auto-refresh: GraphQL failed, falling back to REST API: $graphqlError',
        );
        // Fallback to REST API
        if (selectedLocation == 'All') {
          news = await NewsApiService.fetchNews();
        } else {
          news = await NewsApiService.fetchNewsByLocation(selectedLocation);
        }
        print('🔄 Auto-refresh: Successfully loaded news using REST API');
      }

      // Fetch ads
      ads = await AdApiService.fetchAds();

      // Update ad frequency settings from backend
      for (final ad in ads) {
        await IntelligentAdService.updateAdFrequencySettingsFromBackend(ad);
      }

      // Filter ads intelligently using the new service
      ads = await IntelligentAdService.filterAdsIntelligently(ads);

      // Sort by publishedAt descending (newest first)
      news.sort((a, b) => b.publishedAt.compareTo(a.publishedAt));

      // Store current index and news ID before updating
      final currentNewsId =
          currentIndex < newsList.length ? newsList[currentIndex].id : null;

      // Check if there are new items
      if (news.length > newsList.length) {
        // This is Scenario 1: New news has arrived
        // Save all news to database
        await DatabaseService.saveAllNews(news);

        // Load unread count after saving news
        _loadUnreadNewsCount();

        setState(() {
          allNewsList = selectedLocation == 'All' ? news : allNewsList;
          newsList = news;
          adsList = ads;
          filteredAdsList = ads; // Update filtered ads list

          // Scenario 1: Preserve the user's current position by finding the same news item
          if (currentNewsId != null) {
            final newIndex = newsList.indexWhere(
              (newsItem) => newsItem.id == currentNewsId,
            );
            if (newIndex != -1) {
              // Update the current index to maintain user's position
              currentIndex = newIndex;
              // Move the page controller to the same position
              WidgetsBinding.instance.addPostFrameCallback((_) {
                if (_pageController.hasClients) {
                  _pageController.jumpToPage(newIndex);
                }
              });
            } else {
              // If the current news item is not found, it might have been deleted or repositioned
              // Keep the user at the current index if possible, or adjust to the nearest item
              if (currentIndex < newsList.length) {
                // Current index is still valid
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  if (_pageController.hasClients) {
                    _pageController.jumpToPage(currentIndex);
                  }
                });
              } else if (newsList.isNotEmpty) {
                // Adjust to the last available item
                currentIndex = newsList.length - 1;
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  if (_pageController.hasClients) {
                    _pageController.jumpToPage(currentIndex);
                  }
                });
              }
            }
          }
        });
      } else if (news.length < newsList.length) {
        // Handle case where news was deleted
        setState(() {
          allNewsList = selectedLocation == 'All' ? news : allNewsList;
          newsList = news;
          adsList = ads;
          filteredAdsList = ads; // Update filtered ads list

          // Adjust current index if needed
          if (currentIndex >= newsList.length && newsList.isNotEmpty) {
            currentIndex = newsList.length - 1;
            // Move the page controller to the new position
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (_pageController.hasClients) {
                _pageController.jumpToPage(currentIndex);
              }
            });
          } else if (newsList.isNotEmpty) {
            // Even if length is the same, the current item might have moved
            // Try to find the current news item
            if (currentNewsId != null) {
              final newIndex = newsList.indexWhere(
                (newsItem) => newsItem.id == currentNewsId,
              );
              if (newIndex != -1) {
                currentIndex = newIndex;
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  if (_pageController.hasClients) {
                    _pageController.jumpToPage(currentIndex);
                  }
                });
              }
            }
          }
        });

        // Save all news to database
        await DatabaseService.saveAllNews(news);

        // Load unread count after saving news
        _loadUnreadNewsCount();
      }
      // If lengths are equal, we still update to get latest interactions data
      else if (news.length == newsList.length) {
        setState(() {
          allNewsList = selectedLocation == 'All' ? news : allNewsList;
          newsList = news;
          adsList = ads;
          filteredAdsList = ads; // Update filtered ads list

          // Even if length is the same, items might have been reordered
          // Try to preserve the user's position
          if (currentNewsId != null) {
            final newIndex = newsList.indexWhere(
              (newsItem) => newsItem.id == currentNewsId,
            );
            if (newIndex != -1 && newIndex != currentIndex) {
              currentIndex = newIndex;
              WidgetsBinding.instance.addPostFrameCallback((_) {
                if (_pageController.hasClients) {
                  _pageController.jumpToPage(currentIndex);
                }
              });
            }
          }
        });

        // Save all news to database
        await DatabaseService.saveAllNews(news);

        // Load unread count after saving news
        _loadUnreadNewsCount();
      }

      // IMPORTANT: For automatic refresh, we preserve the user's current position
      // This keeps the user on their current news item even when new news arrives
    } catch (e) {
      // Silently fail on refresh errors to avoid disrupting user experience
      print('Refresh failed: $e');
    } finally {
      setState(() {
        isRefreshing = false;
      });
    }
  }

  Future<void> _refreshNewsFromCard() async {
    // Prevent multiple simultaneous refreshes
    if (isRefreshing) return;

    try {
      setState(() {
        isRefreshing = true;
      });

      List<NewsModel> news;
      List<AdModel> ads = [];

      if (selectedLocation == 'All') {
        final newsData = await GraphQLService.getNews(limit: 100);
        news = newsData.map((item) => NewsModel.fromJson(item)).toList();
      } else {
        final newsData = await GraphQLService.getNews(
          limit: 100,
          location: selectedLocation,
        );
        news = newsData.map((item) => NewsModel.fromJson(item)).toList();
      }

      // Fetch ads
      ads = await AdApiService.fetchAds();

      // Update ad frequency settings from backend
      for (final ad in ads) {
        await IntelligentAdService.updateAdFrequencySettingsFromBackend(ad);
      }

      // Filter ads intelligently using the new service
      ads = await IntelligentAdService.filterAdsIntelligently(ads);

      // Sort by publishedAt descending (newest first)
      news.sort((a, b) => b.publishedAt.compareTo(a.publishedAt));

      // Check if there are new items
      if (news.length > newsList.length) {
        setState(() {
          allNewsList = selectedLocation == 'All' ? news : allNewsList;
          newsList = news;
          adsList = ads;
          filteredAdsList = ads; // Update filtered ads list
        });

        // Save all news to database
        await DatabaseService.saveAllNews(news);

        // Load unread count after saving news
        _loadUnreadNewsCount();
      } else if (news.length < newsList.length) {
        // Handle case where news was deleted
        setState(() {
          allNewsList = selectedLocation == 'All' ? news : allNewsList;
          newsList = news;
          adsList = ads;
          filteredAdsList = ads; // Update filtered ads list
        });

        // Save all news to database
        await DatabaseService.saveAllNews(news);

        // Load unread count after saving news
        _loadUnreadNewsCount();
      }
      // If lengths are equal, we still update to get latest interactions data
      else if (news.length == newsList.length) {
        setState(() {
          allNewsList = selectedLocation == 'All' ? news : allNewsList;
          newsList = news;
          adsList = ads;
          filteredAdsList = ads; // Update filtered ads list
        });

        // Save all news to database
        await DatabaseService.saveAllNews(news);

        // Load unread count after saving news
        _loadUnreadNewsCount();
      }

      // ONLY for manual refresh, reset the page controller to show news from the beginning
      _pageController.jumpToPage(0);
      setState(() {
        currentIndex = 0;
      });
    } catch (e) {
      // Show error message
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to refresh news'),
            duration: Duration(seconds: 2),
            backgroundColor: Colors.red,
          ),
        );
      }
    } finally {
      setState(() {
        isRefreshing = false;
      });
    }
  }

  void _onLocationChanged(String location) async {
    setState(() {
      selectedLocation = location;
      isLoading = true; // Show loading indicator while fetching news
    });

    try {
      List<NewsModel> filteredNews;

      if (location == 'All') {
        // Fetch all news
        final newsData = await GraphQLService.getNews(limit: 100);
        filteredNews =
            newsData.map((item) => NewsModel.fromJson(item)).toList();
      } else {
        // Fetch news for specific location
        final newsData = await GraphQLService.getNews(
          limit: 100,
          location: location,
        );
        filteredNews =
            newsData.map((item) => NewsModel.fromJson(item)).toList();
      }

      // Sort by publishedAt descending (newest first)
      filteredNews.sort((a, b) => b.publishedAt.compareTo(a.publishedAt));

      setState(() {
        allNewsList = location == 'All' ? filteredNews : allNewsList;
        newsList = filteredNews;
        isLoading = false;
      });

      // Show a notification about the filter change
      if (mounted) {
        String message =
            location == 'All'
                ? 'Showing all news'
                : 'Showing news from $location';

        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(message),
            duration: Duration(seconds: 1),
            backgroundColor: Colors.blue,
          ),
        );
      }
    } catch (e) {
      // Handle error
      setState(() {
        isLoading = false;
      });

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to load news for $location'),
            duration: Duration(seconds: 2),
            backgroundColor: Colors.red,
          ),
        );
      }

      // Fallback to filtering existing data
      setState(() {
        newsList =
            location == 'All'
                  ? allNewsList
                  : allNewsList
                      .where((item) => item.location == location)
                      .toList()
              ..sort(
                (a, b) => b.publishedAt.compareTo(a.publishedAt),
              ); // Sort by publishedAt descending (newest first)
      });
    }
  }

  // Update this method to mark news as read and update the UI
  void _markNewsAsRead(String newsId) {
    setState(() {
      // Update in allNewsList
      final allNewsIndex = allNewsList.indexWhere((news) => news.id == newsId);
      if (allNewsIndex != -1) {
        allNewsList[allNewsIndex] = allNewsList[allNewsIndex].copyWith(
          isRead: true,
        );
      }

      // Update in newsList
      final newsIndex = newsList.indexWhere((news) => news.id == newsId);
      if (newsIndex != -1) {
        newsList[newsIndex] = newsList[newsIndex].copyWith(isRead: true);
      }
    });

    // Mark news as read in database
    DatabaseService.markNewsAsRead(newsId);

    // Refresh unread count
    _loadUnreadNewsCount();
  }

  // Add this method to reset read status of all news
  void _resetReadStatus() {
    setState(() {
      // Reset read status in allNewsList
      allNewsList =
          allNewsList.map((news) => news.copyWith(isRead: false)).toList();

      // Reset read status in newsList
      newsList = newsList.map((news) => news.copyWith(isRead: false)).toList();
    });

    // Reset read status in database
    DatabaseService.resetReadStatus();

    // Refresh unread count
    _loadUnreadNewsCount();

    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Read count has been reset'),
          duration: Duration(seconds: 2),
          backgroundColor: Colors.green,
        ),
      );
    }
  }

  // Update this method to navigate to the unread news screen
  void _showUnreadNews() {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder:
            (context) => UnreadNewsScreen(
              allNewsList: allNewsList,
              onNewsInteraction: _onNewsInteraction,
              onRefresh: _refreshNewsFromCard,
              onLocationChanged: _onLocationChanged,
              selectedLocation: selectedLocation,
              onResetReadStatus: _resetReadStatus,
              onMarkAllAsRead: _markAllAsRead,
              onShowAllNews: _showAllNews,
              onShowUnreadNews: _showUnreadNews,
            ),
      ),
    );
  }

  // Update this method to mark all news as read
  void _markAllAsRead() {
    setState(() {
      // Mark all news as read
      allNewsList =
          allNewsList.map((news) => news.copyWith(isRead: true)).toList();

      // Update newsList as well
      newsList = newsList.map((news) => news.copyWith(isRead: true)).toList();
    });

    // Mark all news as read in database
    final newsIds = allNewsList.map((news) => news.id).toList();
    DatabaseService.markAllNewsAsRead(newsIds);

    // Refresh unread count
    _loadUnreadNewsCount();

    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('All news marked as read'),
          duration: Duration(seconds: 2),
          backgroundColor: Colors.green,
        ),
      );
    }
  }

  // Add this method to show all news (reset filter)
  void _showAllNews() async {
    setState(() {
      selectedLocation = 'All';
      isLoading = true;
    });

    try {
      final newsData = await GraphQLService.getNews(limit: 100);
      final news = newsData.map((item) => NewsModel.fromJson(item)).toList();

      // Sort by publishedAt descending (newest first)
      news.sort((a, b) => b.publishedAt.compareTo(a.publishedAt));

      setState(() {
        allNewsList = news;
        newsList = news;
        isLoading = false;
      });

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Showing all news'),
            duration: Duration(seconds: 1),
            backgroundColor: Colors.blue,
          ),
        );
      }
    } catch (e) {
      setState(() {
        isLoading = false;
      });

      // Fallback to existing data
      setState(() {
        newsList = allNewsList;
      });

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to refresh all news'),
            duration: Duration(seconds: 2),
            backgroundColor: Colors.red,
          ),
        );
      }
    }
  }

  @override
  void dispose() {
    _pageController.dispose();
    _refreshTimer?.cancel();
    super.dispose();
  }

  void _onPageChanged(int index) {
    setState(() {
      currentIndex = index;

      // Mark the current news as read when user scrolls to it
      if (index < newsList.length) {
        _markNewsAsRead(newsList[index].id);
        print(
          '👁️ Viewing news #${index + 1}: ${newsList[index].title.substring(0, newsList[index].title.length > 40 ? 40 : newsList[index].title.length)}... (${newsList[index].publishedAt})',
        );
      }
    });
  }

  // Updated method to handle news interactions with Google authentication
  void _onNewsInteraction(
    String newsId,
    String action, {
    String? commentText,
  }) async {
    // For view actions (not like, dislike, or comment), don't require authentication
    if (action != 'like' && action != 'dislike' && action != 'comment') {
      return;
    }

    // Check if user is signed in
    if (!AuthService.isSignedIn) {
      // Show sign in dialog
      final shouldSignIn = await showDialog<bool>(
        context: context,
        builder:
            (context) => AlertDialog(
              title: Text('Sign In Required'),
              content: Text(
                'You need to sign in with Google to like, dislike, or comment on news.',
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.of(context).pop(false),
                  child: Text('Cancel'),
                ),
                TextButton(
                  onPressed: () => Navigator.of(context).pop(true),
                  child: Text('Sign In'),
                ),
              ],
            ),
      );

      // If user chose not to sign in, return
      if (shouldSignIn != true) {
        return;
      }

      // Sign in with Google
      final user = await AuthService.signIn();
      if (user == null) {
        // Show error message if sign in failed
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('Failed to sign in with Google'),
              duration: Duration(seconds: 2),
              backgroundColor: Colors.red,
            ),
          );
        }
        return;
      }
    }

    // Get user ID and token
    final userId = AuthService.getUserId();
    final userToken = await AuthService.getAuthToken();

    // If we don't have user ID or token, show error
    if (userId == null || userToken == null) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to get user authentication'),
            duration: Duration(seconds: 2),
            backgroundColor: Colors.red,
          ),
        );
      }
      return;
    }

    // For comments, show a dialog to enter comment text
    String? finalCommentText = commentText;
    if (action == 'comment' && commentText == null) {
      finalCommentText = await showDialog<String>(
        context: context,
        builder:
            (context) => AlertDialog(
              title: Text('Add Comment'),
              content: TextField(
                decoration: InputDecoration(hintText: 'Enter your comment'),
                autofocus: true,
                onSubmitted: (value) => Navigator.of(context).pop(value),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: Text('Cancel'),
                ),
                TextButton(
                  onPressed: () {
                    // Get the text from the TextField
                    final textField =
                        context.findAncestorWidgetOfExactType<TextField>();
                    Navigator.of(
                      context,
                    ).pop(textField?.decoration?.hintText ?? '');
                  },
                  child: Text('Submit'),
                ),
              ],
            ),
      );

      // If user cancelled or entered empty comment, return
      if (finalCommentText == null || finalCommentText.trim().isEmpty) {
        return;
      }
    }

    try {
      // Call the GraphQL API to interact with the news
      Map<String, dynamic>? updatedNews;

      if (action == 'like') {
        updatedNews = await GraphQLService.likeNews(newsId);
      } else if (action == 'dislike') {
        updatedNews = await GraphQLService.dislikeNews(newsId);
      } else if (action == 'comment' && finalCommentText != null) {
        updatedNews = await GraphQLService.addComment(newsId, finalCommentText);
      }

      // Update the news in our lists if we got a response
      if (updatedNews != null) {
        setState(() {
          // Update in allNewsList
          final allNewsIndex = allNewsList.indexWhere(
            (news) => news.id == newsId,
          );
          if (allNewsIndex != -1) {
            // Update only the changed fields
            allNewsList[allNewsIndex] = allNewsList[allNewsIndex].copyWith(
              likes:
                  (updatedNews!['likes'] as int?) ??
                  allNewsList[allNewsIndex].likes,
              dislikes:
                  (updatedNews['dislikes'] as int?) ??
                  allNewsList[allNewsIndex].dislikes,
              // Note: comments would need to be converted from the response
            );
          }

          // Update in newsList
          final newsIndex = newsList.indexWhere((news) => news.id == newsId);
          if (newsIndex != -1) {
            // Update only the changed fields
            newsList[newsIndex] = newsList[newsIndex].copyWith(
              likes:
                  (updatedNews!['likes'] as int?) ?? newsList[newsIndex].likes,
              dislikes:
                  (updatedNews['dislikes'] as int?) ??
                  newsList[newsIndex].dislikes,
              // Note: comments would need to be converted from the response
            );
          }
        });
      }

      // Show success message
      String actionText = '';
      switch (action) {
        case 'like':
          actionText = 'liked';
          break;
        case 'dislike':
          actionText = 'disliked';
          break;
        case 'comment':
          actionText = 'commented on';
          break;
        default:
          actionText = action;
      }

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Successfully $actionText the news'),
            duration: Duration(seconds: 1),
            backgroundColor: Colors.green,
          ),
        );
      }
    } catch (e) {
      // Show error message
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to $action the news: ${e.toString()}'),
            duration: Duration(seconds: 2),
            backgroundColor: Colors.red,
          ),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(
        child: Column(
          children: [
            // Main content area
            Expanded(child: _buildContent()),
            // Page indicator
          ],
        ),
      ),
    );
  }

  Widget _buildContent() {
    if (isLoading) {
      // Show multiple shimmer cards for a better loading experience
      return PageView.builder(
        scrollDirection: Axis.vertical,
        itemCount: 3, // Show 3 shimmer cards
        itemBuilder: (context, index) {
          return const ShimmerNewsCard();
        },
      );
    }

    if (errorMessage != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, color: Colors.white, size: 64),
            const SizedBox(height: 16),
            Text(
              'Failed to load news',
              style: TextStyle(
                color: Colors.white,
                fontSize: 18,
                fontWeight: FontWeight.bold,
                fontFamily: 'TeluguFont',
              ),
            ),
            const SizedBox(height: 8),
            Text(
              'Using sample data',
              style: TextStyle(
                color: Colors.grey,
                fontSize: 14,
                fontFamily: 'TeluguFont',
              ),
            ),
            const SizedBox(height: 16),
            ElevatedButton(
              onPressed: _loadNews,
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.blue,
                foregroundColor: Colors.white,
              ),
              child: const Text('Retry'),
            ),
          ],
        ),
      );
    }

    if (newsList.isEmpty) {
      return const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.article_outlined, color: Colors.white, size: 64),
            SizedBox(height: 16),
            Text(
              'No news available',
              style: TextStyle(
                color: Colors.white,
                fontSize: 18,
                fontWeight: FontWeight.bold,
                fontFamily: 'TeluguFont',
              ),
            ),
          ],
        ),
      );
    }

    // Create a combined list of news and ads based on position intervals
    final List<dynamic> combinedList = _createIntelligentAdPlacement();

    return RefreshIndicator(
      onRefresh: _refreshNews,
      child: PageView.builder(
        controller: _pageController,
        onPageChanged: _onPageChanged,
        scrollDirection: Axis.vertical,
        itemCount: combinedList.length,
        itemBuilder: (context, index) {
          final item = combinedList[index];

          // Check if the item is an AdModel or NewsModel
          if (item is AdModel) {
            // Check if this ad should use AdMob
            if (item.useAdMob == true) {
              // This is an AdMob ad
              return AdMobCard(
                adId: item.id,
                adTitle: item.title,
                onAdLoaded: () {
                  // Record ad view interaction using intelligent ad service
                  IntelligentAdService.recordAdAnalytics(
                    adId: item.id,
                    adTitle: item.title,
                    interactionType: 'view',
                  );
                  debugPrint('AdMob ad loaded successfully: ${item.id}');
                },
                onAdFailedToLoad: () {
                  debugPrint('AdMob ad failed to load: ${item.id}');
                },
              );
            } else {
              // This is a regular ad
              return AdCard(
                ad: item,
                onTap: () {
                  // Record ad click interaction using intelligent ad service
                  IntelligentAdService.recordAdAnalytics(
                    adId: item.id,
                    adTitle: item.title,
                    interactionType: 'click',
                  );
                  // Mark ad as recently seen to avoid immediate repetition
                  setState(() {
                    recentlySeenAds.add(item.id);
                  });
                },
              );
            }
          } else if (item is NewsModel) {
            // This is a news item
            return NewsCard(
              news: item,
              onInteraction:
                  (newsId, action) => _onNewsInteraction(newsId, action),
              onRefresh: _refreshNewsFromCard,
              onLocationChanged: _onLocationChanged,
              selectedLocation: selectedLocation,
              allNewsList: allNewsList,
              onResetReadStatus: _resetReadStatus,
              onShowUnreadNews: _showUnreadNews,
              onMarkAllAsRead: _markAllAsRead,
              onShowAllNews: _showAllNews,
            );
          } else {
            // Fallback for unknown item types
            return Container();
          }
        },
      ),
    );
  }

  // Create a Google AdMob ad model for automatic insertion
  AdModel _createGoogleAdMobAd(int index) {
    return AdModel(
      id: 'google_admob_$index',
      title: 'Advertisement',
      imageUrl: '',
      imageUrls: [],
      positionInterval: 3, // Show every 3 news items
      createdAt: DateTime.now(),
      useAdMob: true, // Mark as AdMob ad
    );
  }

  // Create intelligent ad placement based on user behavior
  List<dynamic> _createIntelligentAdPlacement() {
    final List<dynamic> combinedList = [];

    // Create a map to track next insertion position for each ad
    final adNextPositions = <String, int>{};

    // Filter out recently seen ads
    final availableAds =
        filteredAdsList
            .where((ad) => !recentlySeenAds.contains(ad.id))
            .toList();

    // If no ads are available (all recently seen), use all ads but mark them as seen
    final adsToUse = availableAds.isEmpty ? filteredAdsList : availableAds;

    // Track Google AdMob ad insertion
    int googleAdMobCounter = 0;
    int nextGoogleAdMobPosition =
        3; // First AdMob ad after 3 news items (1-indexed)

    for (var ad in adsToUse) {
      adNextPositions[ad.id] = ad.positionInterval - 1; // 0-indexed
    }

    int newsIndex = 0;

    // Insert news and ads based on ad position intervals
    while (newsIndex < newsList.length) {
      // Add any ads that should appear before or at the current news item
      for (var ad in adsToUse) {
        if (adNextPositions[ad.id] == newsIndex) {
          combinedList.add(ad);
          // Update next position for this ad
          adNextPositions[ad.id] =
              adNextPositions[ad.id]! + ad.positionInterval;

          // Record ad view interaction using intelligent ad service
          IntelligentAdService.recordAdAnalytics(
            adId: ad.id,
            adTitle: ad.title,
            interactionType: 'view',
          );

          // Update ad view count
          setState(() {
            adViewCounts[ad.id] = (adViewCounts[ad.id] ?? 0) + 1;
          });
        }
      }

      // Add the current news item
      combinedList.add(newsList[newsIndex]);
      newsIndex++;

      // Automatically insert Google AdMob ads at regular intervals (every 3 news items)
      // This ensures Google AdMob ads are always displayed between news items
      if (newsIndex == nextGoogleAdMobPosition && newsIndex < newsList.length) {
        final googleAdMobAd = _createGoogleAdMobAd(googleAdMobCounter);
        combinedList.add(googleAdMobAd);
        googleAdMobCounter++;
        // Next AdMob ad after 3 more news items
        nextGoogleAdMobPosition = newsIndex + 3;

        debugPrint('✅ Google AdMob ad inserted at position $newsIndex');
      }
    }

    // Add any remaining ads that should appear after the last news item
    // This is optional and can be removed if we only want ads to appear within the news list
    for (var ad in adsToUse) {
      if (adNextPositions[ad.id]! < newsList.length) {
        combinedList.add(ad);
      }
    }

    return combinedList;
  }
}
