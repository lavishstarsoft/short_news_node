import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/news_model.dart';
import '../models/ad_model.dart'; // Add this import
import '../widgets/news_card.dart';
import '../widgets/ad_card.dart'; // Add this import
import '../services/database_service.dart'; // Add this import
import '../services/ad_api_service.dart'; // Add this import

class UnreadNewsScreen extends StatefulWidget {
  final List<NewsModel> allNewsList;
  final Function(String newsId, String action) onNewsInteraction;
  final Function() onRefresh;
  final Function(String location) onLocationChanged;
  final String selectedLocation;
  final Function() onResetReadStatus;
  final Function() onMarkAllAsRead;
  final Function() onShowAllNews;
  final Function() onShowUnreadNews;

  const UnreadNewsScreen({
    super.key,
    required this.allNewsList,
    required this.onNewsInteraction,
    required this.onRefresh,
    required this.onLocationChanged,
    required this.selectedLocation,
    required this.onResetReadStatus,
    required this.onMarkAllAsRead,
    required this.onShowAllNews,
    required this.onShowUnreadNews,
  });

  @override
  State<UnreadNewsScreen> createState() => _UnreadNewsScreenState();
}

class _UnreadNewsScreenState extends State<UnreadNewsScreen> {
  late PageController _pageController;
  List<NewsModel> unreadNewsList = [];
  List<AdModel> adsList = []; // Add this line for ads
  int currentIndex = 0;
  Set<String> readNewsIds = <String>{};

  @override
  void initState() {
    super.initState();
    _pageController = PageController();
    _loadReadNewsIds().then((_) {
      _filterUnreadNews();
      _loadAds(); // Add this line to load ads
    });
  }

  Future<void> _loadAds() async {
    try {
      final ads = await AdApiService.fetchAds();
      if (mounted) {
        setState(() {
          adsList = ads;
        });
      }
    } catch (e) {
      print('Error loading ads: $e');
    }
  }

  Future<void> _loadReadNewsIds() async {
    try {
      // Get all read news IDs from database
      final db = await DatabaseService.database;
      final List<Map<String, dynamic>> result = await db.query('read_news');
      setState(() {
        readNewsIds = result.map((row) => row['id'] as String).toSet();
      });
    } catch (e) {
      print('Error loading read news IDs: $e');
    }
  }

  void _filterUnreadNews() {
    setState(() {
      // Filter unread news from the last 24 hours using database read status
      unreadNewsList = widget.selectedLocation == 'All'
          ? widget.allNewsList
              .where((news) => !readNewsIds.contains(news.id) && 
                    news.publishedAt.isAfter(DateTime.now().subtract(Duration(hours: 24))))
              .toList()
          : widget.allNewsList
              .where((news) => !readNewsIds.contains(news.id) && 
                    news.location == widget.selectedLocation &&
                    news.publishedAt.isAfter(DateTime.now().subtract(Duration(hours: 24))))
              .toList()
                ..sort((a, b) => b.publishedAt.compareTo(a.publishedAt));
    });
  }

  // Add this method to mark a specific news as read
  void _markNewsAsRead(String newsId) {
    // Update in the parent's allNewsList
    widget.onNewsInteraction(newsId, 'markAsRead');
    
    // Mark news as read in database
    DatabaseService.markNewsAsRead(newsId);
    
    // Update local read news IDs set
    setState(() {
      readNewsIds.add(newsId);
    });
    
    // Refresh the unread news list
    _filterUnreadNews();
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  void _onPageChanged(int index) {
    setState(() {
      currentIndex = index;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(
        child: Column(
          children: [
            // Header with back button and title
            Container(
              padding: EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [
                    Color(0xFFFF6B6B).withValues(alpha: 0.5),
                    Color(0xFFFF8E53).withValues(alpha: 0.4),
                  ],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                boxShadow: [
                  BoxShadow(
                    color: Color(0xFFFF6B6B).withValues(alpha: 0.4),
                    blurRadius: 12,
                    offset: Offset(0, 4),
                  ),
                ],
              ),
              child: Row(
                children: [
                  GestureDetector(
                    onTap: () => Navigator.of(context).pop(),
                    child: Container(
                      padding: EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.2),
                        shape: BoxShape.circle,
                      ),
                      child: Icon(
                        Icons.arrow_back,
                        color: Colors.white,
                        size: 24,
                      ),
                    ),
                  ),
                  SizedBox(width: 16),
                  Text(
                    'Unread News',
                    style: TextStyle(
                      color: Colors.white,
                      fontSize: 20,
                      fontWeight: FontWeight.bold,
                      fontFamily: 'TeluguFont',
                    ),
                  ),
                  Spacer(),
                  // Mark all as read button
                  GestureDetector(
                    onTap: () async {
                      await widget.onMarkAllAsRead();
                      if (mounted) {
                        Navigator.of(context).pop();
                      }
                    },
                    child: Container(
                      padding: EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.2),
                        borderRadius: BorderRadius.circular(20),
                      ),
                      child: Text(
                        'Mark All Read',
                        style: TextStyle(
                          color: Colors.white,
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            // Main content area
            Expanded(
              child: unreadNewsList.isEmpty
                  ? _buildEmptyState()
                  : Builder(
                      builder: (context) {
                        // Create a combined list of news and ads
                        final List<dynamic> combinedList = [];
                        int adIndex = 0;
                        
                        for (int i = 0; i < unreadNewsList.length; i++) {
                          // Add the news item
                          combinedList.add(unreadNewsList[i]);
                          
                          // Add an ad every 3 news items (at positions 3, 6, 9, etc.)
                          if ((i + 1) % 3 == 0 && adIndex < adsList.length) {
                            combinedList.add(adsList[adIndex]);
                            adIndex++;
                          }
                        }
                        
                        return PageView.builder(
                          controller: _pageController,
                          onPageChanged: _onPageChanged,
                          scrollDirection: Axis.vertical,
                          itemCount: combinedList.length,
                          itemBuilder: (context, index) {
                            final item = combinedList[index];
                            
                            // Check if the item is an AdModel or NewsModel
                            if (item is AdModel) {
                              // This is an ad item
                              return AdCard(ad: item);
                            } else if (item is NewsModel) {
                              // This is a news item
                              return NewsCard(
                                news: item,
                                onInteraction: widget.onNewsInteraction,
                                onRefresh: widget.onRefresh,
                                onLocationChanged: widget.onLocationChanged,
                                selectedLocation: widget.selectedLocation,
                                allNewsList: widget.allNewsList,
                                onResetReadStatus: widget.onResetReadStatus,
                                onShowUnreadNews: widget.onShowUnreadNews,
                                onMarkAllAsRead: widget.onMarkAllAsRead,
                                onShowAllNews: widget.onShowAllNews,
                              );
                            } else {
                              // Fallback for unknown item types
                              return Container();
                            }
                          },
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildEmptyState() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.visibility_off,
            color: Colors.white54,
            size: 64,
          ),
          SizedBox(height: 16),
          Text(
            'No unread news',
            style: TextStyle(
              color: Colors.white70,
              fontSize: 18,
              fontWeight: FontWeight.w500,
            ),
          ),
          SizedBox(height: 8),
          Text(
            'All news have been read or are older than 24 hours',
            style: TextStyle(
              color: Colors.white54,
              fontSize: 14,
            ),
            textAlign: TextAlign.center,
          ),
          SizedBox(height: 24),
          ElevatedButton(
            onPressed: () {
              widget.onShowAllNews();
              Navigator.of(context).pop();
            },
            style: ElevatedButton.styleFrom(
              backgroundColor: Colors.blue,
              foregroundColor: Colors.white,
            ),
            child: Text('Show All News'),
          ),
        ],
      ),
    );
  }
}