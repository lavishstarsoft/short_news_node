import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:share_plus/share_plus.dart';
import 'package:video_player/video_player.dart';
import 'package:http/http.dart' as http;
import 'package:shimmer/shimmer.dart';
import 'package:screenshot/screenshot.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/news_model.dart';
import '../screens/profilepage.dart';
import '../services/news_api_service.dart';
import '../services/database_service.dart';
import '../services/mobile_auth_service.dart';
import '../screens/unread_news_screen.dart';
import '../services/tts_service.dart';
import 'fullscreen_video_player.dart';
import 'comment_bottom_sheet.dart';
import '../utils/auth_utils.dart';
import '../screens/viral_videos_screen.dart';

class SocialApp {
  final IconData icon;
  final String label;
  final Color color;
  final Function(BuildContext) onTap;

  SocialApp({
    required this.icon,
    required this.label,
    required this.color,
    required this.onTap,
  });
}

class NewsCard extends StatefulWidget {
  final NewsModel news;
  final Function(String newsId, String action) onInteraction;
  final Function() onRefresh;
  final Function(String location) onLocationChanged;
  final String selectedLocation;
  final List<NewsModel> allNewsList;
  final Function() onResetReadStatus;
  final Function() onShowUnreadNews;
  final Function() onMarkAllAsRead;
  final Function() onShowAllNews;

  const NewsCard({
    super.key,
    required this.news,
    required this.onInteraction,
    required this.onRefresh,
    required this.onLocationChanged,
    required this.selectedLocation,
    required this.allNewsList,
    required this.onResetReadStatus,
    required this.onShowUnreadNews,
    required this.onMarkAllAsRead,
    required this.onShowAllNews,
  });

  @override
  State<NewsCard> createState() => _NewsCardState();
}

class _NewsCardState extends State<NewsCard> with TickerProviderStateMixin {
  bool _showOverlay = false;
  bool _showVideoControls = false;
  bool _isRefreshing = false;
  bool _isCapturingScreenshot = false;
  bool _isBookmarked = false; // Add bookmark state
  bool _isLiked = false;
  bool _isDisliked = false;
  int _likeCount = 0;
  int _dislikeCount = 0;
  Timer? _hideTimer;
  Timer? _videoControlsHideTimer;
  late AnimationController _fadeController;
  late Animation<double> _fadeAnimation;
  VideoPlayerController? _videoController;
  bool _isVideoInitialized = false;
  final ScreenshotController _screenshotController = ScreenshotController();
  int _unreadNewsCount = 0;
  bool _isSpeaking = false; // TTS state
  final TtsService _ttsService = TtsService();

  @override
  void initState() {
    super.initState();
    _fadeController = AnimationController(
      duration: const Duration(milliseconds: 300),
      vsync: this,
    );
    _fadeAnimation = Tween<double>(
      begin: 0.0,
      end: 1.0,
    ).animate(_fadeController);
    _initializeVideo();
    _loadUnreadNewsCount();
    _checkIfBookmarked();
    _loadLikeStatus();
    _ttsService.initialize(); // Initialize TTS
  }

  // Check if the current news is bookmarked
  Future<void> _checkIfBookmarked() async {
    final prefs = await SharedPreferences.getInstance();
    final bookmarkedIds = prefs.getStringList('bookmarkedNews') ?? [];
    setState(() {
      _isBookmarked = bookmarkedIds.contains(widget.news.id);
    });
  }

  // Toggle bookmark status for the current news
  Future<void> _toggleBookmark() async {
    final prefs = await SharedPreferences.getInstance();
    final bookmarkedIds = prefs.getStringList('bookmarkedNews') ?? [];

    if (_isBookmarked) {
      // Remove from bookmarks
      bookmarkedIds.remove(widget.news.id);
    } else {
      // Add to bookmarks
      bookmarkedIds.add(widget.news.id);
    }

    await prefs.setStringList('bookmarkedNews', bookmarkedIds);

    setState(() {
      _isBookmarked = !_isBookmarked;
    });
  }

  Future<void> _loadLikeStatus() async {
    final prefs = await SharedPreferences.getInstance();
    final likedNewsIds = prefs.getStringList('likedNews') ?? [];
    final dislikedNewsIds = prefs.getStringList('dislikedNews') ?? [];

    setState(() {
      _isLiked = likedNewsIds.contains(widget.news.id);
      _isDisliked = dislikedNewsIds.contains(widget.news.id);
      _likeCount = prefs.getInt('likeCount_${widget.news.id}') ?? 0;
      _dislikeCount = prefs.getInt('dislikeCount_${widget.news.id}') ?? 0;
    });
  }

  Future<void> _handleLike() async {
    // Check authentication first
    final isAuthorized = await AuthUtils.showAuthBottomSheetIfNeeded(
      context,
      MobileAuthService.instance.isAuthenticated,
    );

    if (!isAuthorized) return;

    final prefs = await SharedPreferences.getInstance();
    final likedNewsIds = prefs.getStringList('likedNews') ?? [];
    final dislikedNewsIds = prefs.getStringList('dislikedNews') ?? [];

    setState(() {
      if (_isLiked) {
        // Unlike the news
        _likeCount--;
        likedNewsIds.remove(widget.news.id);
        _isLiked = false;
      } else {
        // Like the news
        _likeCount++;
        likedNewsIds.add(widget.news.id);
        _isLiked = true;

        // Remove dislike if exists
        if (_isDisliked) {
          _dislikeCount--;
          dislikedNewsIds.remove(widget.news.id);
          _isDisliked = false;
        }
      }
    });

    await prefs.setStringList('likedNews', likedNewsIds);
    await prefs.setStringList('dislikedNews', dislikedNewsIds);
    await prefs.setInt('likeCount_${widget.news.id}', _likeCount);
    await prefs.setInt('dislikeCount_${widget.news.id}', _dislikeCount);

    // Call the interaction callback and refresh
    await widget.onInteraction(widget.news.id, _isLiked ? 'like' : 'unlike');
    await widget.onRefresh();
  }

  Future<void> _handleDislike() async {
    // Check authentication first
    final isAuthorized = await AuthUtils.showAuthBottomSheetIfNeeded(
      context,
      MobileAuthService.instance.isAuthenticated,
    );

    if (!isAuthorized) return;

    final prefs = await SharedPreferences.getInstance();
    final likedNewsIds = prefs.getStringList('likedNews') ?? [];
    final dislikedNewsIds = prefs.getStringList('dislikedNews') ?? [];

    setState(() {
      if (_isDisliked) {
        // Remove dislike
        _dislikeCount--;
        dislikedNewsIds.remove(widget.news.id);
        _isDisliked = false;
      } else {
        // Add dislike
        _dislikeCount++;
        dislikedNewsIds.add(widget.news.id);
        _isDisliked = true;

        // Remove like if exists
        if (_isLiked) {
          _likeCount--;
          likedNewsIds.remove(widget.news.id);
          _isLiked = false;
        }
      }
    });

    await prefs.setStringList('likedNews', likedNewsIds);
    await prefs.setStringList('dislikedNews', dislikedNewsIds);
    await prefs.setInt('likeCount_${widget.news.id}', _likeCount);
    await prefs.setInt('dislikeCount_${widget.news.id}', _dislikeCount);

    // Call the interaction callback and refresh
    await widget.onInteraction(
      widget.news.id,
      _isDisliked ? 'dislike' : 'undislike',
    );
    await widget.onRefresh();
  }

  // Handle voice/TTS button tap
  Future<void> _handleVoiceButton() async {
    try {
      if (_isSpeaking) {
        // Stop speaking
        await _ttsService.stop();
        setState(() {
          _isSpeaking = false;
        });
      } else {
        // Start speaking
        final textToSpeak = '${widget.news.title}. ${widget.news.content}';
        await _ttsService.speak(textToSpeak, widget.news.id);
        setState(() {
          _isSpeaking = true;
        });

        // Show snackbar
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('Reading news aloud...'),
              duration: Duration(seconds: 2),
              backgroundColor: Colors.green,
            ),
          );
        }
      }
    } catch (e) {
      print('❌ Voice button error: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Voice feature not available'),
            duration: Duration(seconds: 2),
            backgroundColor: Colors.red,
          ),
        );
      }
    }
  }

  Future<void> _showCommentSheet(BuildContext context) async {
    // Refresh the news data to get latest comments
    await widget.onRefresh();

    if (!mounted) return;

    // Since the widget might not be rebuilt with new data, we need to find the updated news item
    // by searching through the allNewsList that's passed to the widget
    NewsModel updatedNews = widget.news;

    // Try to find the updated news item in the allNewsList
    try {
      final newsIndex = widget.allNewsList.indexWhere(
        (news) => news.id == widget.news.id,
      );
      if (newsIndex != -1) {
        updatedNews = widget.allNewsList[newsIndex];
      }
    } catch (e) {
      print('Error finding updated news item: $e');
    }

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder:
          (context) => CommentBottomSheet(
            newsId: updatedNews.id,
            news: updatedNews, // Pass the updated news model
            onComment: (comment) {
              widget.onInteraction(widget.news.id, 'comment');
            },
          ),
    );
  }

  Future<void> _loadUnreadNewsCount() async {
    try {
      final count = await DatabaseService.getUnreadNewsCount();
      if (mounted) {
        setState(() {
          _unreadNewsCount = count;
        });
      }
    } catch (e) {
      print('Error loading unread news count in NewsCard: $e');
    }
  }

  @override
  void dispose() {
    _hideTimer?.cancel();
    _videoControlsHideTimer?.cancel();
    _fadeController.dispose();
    _videoController?.dispose();
    _ttsService.stop(); // Stop TTS when widget is disposed
    super.dispose();
  }

  void _initializeVideo() async {
    String videoSource = widget.news.mediaUrl ?? widget.news.imageUrl;

    if (widget.news.mediaType == 'video' && videoSource.isNotEmpty) {
      try {
        final videoUrl = NewsApiService.getFullImageUrl(videoSource);
        print('Initializing video with URL: $videoUrl');

        final response = await http.get(
          Uri.parse(videoUrl),
          headers: {'Range': 'bytes=0-1023'},
        );
        if (response.statusCode != 200 && response.statusCode != 206) {
          throw Exception('Video URL not accessible: ${response.statusCode}');
        }
        print(
          'Video URL is accessible, content-type: ${response.headers['content-type']}',
        );

        _videoController = VideoPlayerController.networkUrl(
          Uri.parse(videoUrl),
          videoPlayerOptions: VideoPlayerOptions(
            mixWithOthers: true,
            allowBackgroundPlayback: false,
          ),
        );

        _videoController!.addListener(() {
          if (_videoController!.value.hasError) {
            print(
              'Video player error: ${_videoController!.value.errorDescription}',
            );
          }

          if (_videoController!.value.isPlaying) {
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (mounted) {
                setState(() {
                  _showVideoControls = true;
                });

                _videoControlsHideTimer?.cancel();

                _videoControlsHideTimer = Timer(Duration(seconds: 1), () {
                  if (mounted) {
                    setState(() {
                      _showVideoControls = false;
                    });
                  }
                });
              }
            });
          } else {
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (mounted) {
                setState(() {
                  _showVideoControls = true;
                });
              }
            });
          }

          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted) {
              setState(() {});
            }
          });
        });

        await _videoController!.initialize().timeout(
          Duration(seconds: 15),
          onTimeout: () {
            throw Exception('Video initialization timeout');
          },
        );

        // Set video to loop
        await _videoController!.setLooping(true);

        if (mounted) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted) {
              setState(() {
                _isVideoInitialized = true;
              });
              print('Video initialized successfully');
              print('Video duration: ${_videoController!.value.duration}');
              print('Video buffering: ${_videoController!.value.isBuffering}');
              print('Video ready to play');
            }
          });
        }
      } catch (e) {
        print('Error initializing video: $e');
        print('Video URL was: ${NewsApiService.getFullImageUrl(videoSource)}');

        if (mounted) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted) {
              setState(() {
                _isVideoInitialized = false;
              });
            }
          });
        }
      }
    }
  }

  void _toggleOverlay() {
    // Don't toggle overlay when capturing screenshot
    if (_isCapturingScreenshot) {
      return;
    }

    setState(() {
      _showOverlay = !_showOverlay;
    });

    // Mark news as read when overlay is shown (user is viewing the news)
    if (!_showOverlay) {
      widget.onInteraction(widget.news.id, 'markAsRead');
    }

    if (_showOverlay) {
      _fadeController.forward();
      _hideTimer?.cancel();
      // Only auto-hide if not capturing screenshot
      if (!_isCapturingScreenshot) {
        _hideTimer = Timer(const Duration(seconds: 4), () {
          if (mounted) {
            setState(() {
              _showOverlay = false;
            });
            _fadeController.reverse();
          }
        });
      }
    } else {
      _hideTimer?.cancel();
      _fadeController.reverse();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      height: double.infinity,
      child: GestureDetector(
        onTap: _toggleOverlay,
        child: Screenshot(
          controller: _screenshotController,
          child: Stack(
            children: [
              Column(
                children: [
                  Expanded(
                    flex: 13, // 65% of screen for image
                    child: Container(
                      color: Colors.black, // Background color for letterboxing
                      child: Stack(
                        children: [
                          if (widget.news.mediaType == 'video' &&
                              _isVideoInitialized &&
                              _videoController != null)
                            Container(
                              width: double.infinity,
                              child: Center(
                                child: AspectRatio(
                                  aspectRatio: 16 / 9, // 16:9 ratio for videos
                                  child: Stack(
                                    children: [
                                      Positioned.fill(
                                        child: VideoPlayer(_videoController!),
                                      ),
                                      Center(
                                        child: AnimatedOpacity(
                                          opacity:
                                              _showVideoControls ||
                                                      !(_videoController
                                                              ?.value
                                                              .isPlaying ??
                                                          false)
                                                  ? 1.0
                                                  : 0.0,
                                          duration: Duration(milliseconds: 300),
                                          child: GestureDetector(
                                            onTap: () {
                                              if (_videoController!
                                                  .value
                                                  .isPlaying) {
                                                _videoController!.pause();
                                                WidgetsBinding.instance
                                                    .addPostFrameCallback((_) {
                                                      if (mounted) {
                                                        setState(() {
                                                          _showVideoControls =
                                                              true;
                                                        });
                                                      }
                                                    });
                                              } else {
                                                _videoController!.play();
                                                WidgetsBinding.instance
                                                    .addPostFrameCallback((_) {
                                                      if (mounted) {
                                                        setState(() {
                                                          _showVideoControls =
                                                              true;
                                                        });

                                                        _videoControlsHideTimer
                                                            ?.cancel();

                                                        _videoControlsHideTimer =
                                                            Timer(
                                                              Duration(
                                                                seconds: 1,
                                                              ),
                                                              () {
                                                                if (mounted) {
                                                                  setState(() {
                                                                    _showVideoControls =
                                                                        false;
                                                                  });
                                                                }
                                                              },
                                                            );
                                                      }
                                                    });
                                              }
                                              WidgetsBinding.instance
                                                  .addPostFrameCallback((_) {
                                                    if (mounted) {
                                                      setState(() {});
                                                    }
                                                  });
                                            },
                                            child: Container(
                                              padding: EdgeInsets.all(12),
                                              decoration: BoxDecoration(
                                                color: Colors.white,
                                                shape: BoxShape.circle,
                                                border: Border.all(
                                                  color: Colors.white,
                                                  width: 2.0,
                                                ),
                                                boxShadow: [
                                                  BoxShadow(
                                                    color: Colors.black
                                                        .withValues(alpha: 0.3),
                                                    blurRadius: 8,
                                                    offset: Offset(0, 2),
                                                  ),
                                                ],
                                              ),
                                              child: Icon(
                                                _videoController!
                                                        .value
                                                        .isPlaying
                                                    ? Icons.pause
                                                    : Icons.play_arrow,
                                                color: Colors.black,
                                                size: 36,
                                              ),
                                            ),
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            )
                          else if (widget.news.mediaType == 'video' &&
                              !_isVideoInitialized)
                            Stack(
                              children: [
                                Shimmer.fromColors(
                                  baseColor: Colors.grey[800]!,
                                  highlightColor: Colors.grey[700]!,
                                  child: Center(
                                    child: AspectRatio(
                                      aspectRatio:
                                          widget.news.imageUrl.isNotEmpty
                                              ? 16 / 9
                                              : 1,
                                      child: Container(
                                        width: double.infinity,
                                        height: double.infinity,
                                        color: Colors.grey[800],
                                      ),
                                    ),
                                  ),
                                ),
                                Center(
                                  child: Container(
                                    padding: EdgeInsets.all(20),
                                    decoration: BoxDecoration(
                                      color: Colors.black.withValues(
                                        alpha: 0.7,
                                      ),
                                      shape: BoxShape.circle,
                                    ),
                                    child: Icon(
                                      Icons.play_arrow,
                                      color: Colors.white,
                                      size: 60,
                                    ),
                                  ),
                                ),
                                Center(
                                  child: Container(
                                    padding: EdgeInsets.all(8),
                                    decoration: BoxDecoration(
                                      color: Colors.black.withValues(
                                        alpha: 0.7,
                                      ),
                                      shape: BoxShape.circle,
                                    ),
                                    child: CircularProgressIndicator(
                                      valueColor: AlwaysStoppedAnimation<Color>(
                                        Colors.white,
                                      ),
                                      strokeWidth: 2,
                                    ),
                                  ),
                                ),
                              ],
                            )
                          else if (widget.news.mediaType == 'video' &&
                              _videoController?.value.hasError == true)
                            Stack(
                              children: [
                                Center(
                                  child: AspectRatio(
                                    aspectRatio:
                                        widget.news.imageUrl.isNotEmpty
                                            ? 16 / 9
                                            : 1,
                                    child: CachedNetworkImage(
                                      imageUrl: NewsApiService.getFullImageUrl(
                                        widget.news.imageUrl,
                                      ),
                                      width: double.infinity,
                                      height: double.infinity,
                                      fit: BoxFit.cover,
                                      placeholder:
                                          (context, url) => Container(
                                            color: Colors.grey[800],
                                            child: Center(
                                              child: CircularProgressIndicator(
                                                color: Colors.white,
                                              ),
                                            ),
                                          ),
                                      errorWidget:
                                          (context, url, error) => Container(
                                            color: Colors.grey[800],
                                            child: Center(
                                              child: Column(
                                                mainAxisAlignment:
                                                    MainAxisAlignment.center,
                                                children: [
                                                  Icon(
                                                    Icons.video_library,
                                                    color: Colors.white,
                                                    size: 50,
                                                  ),
                                                  SizedBox(height: 16),
                                                  Text(
                                                    'Video not available',
                                                    style: TextStyle(
                                                      color: Colors.white,
                                                      fontSize: 16,
                                                    ),
                                                  ),
                                                ],
                                              ),
                                            ),
                                          ),
                                    ),
                                  ),
                                ),
                                Center(
                                  child: GestureDetector(
                                    onTap: () async {
                                      _videoController?.dispose();
                                      _videoController = null;
                                      _isVideoInitialized = false;

                                      WidgetsBinding.instance
                                          .addPostFrameCallback((_) {
                                            if (mounted) {
                                              setState(() {});
                                            }
                                          });

                                      await Future.delayed(
                                        Duration(milliseconds: 500),
                                      );
                                      _initializeVideo();

                                      Future.delayed(
                                        Duration(seconds: 3),
                                        () async {
                                          if (!_isVideoInitialized && mounted) {
                                            final videoUrl =
                                                NewsApiService.getFullImageUrl(
                                                  widget.news.mediaUrl ??
                                                      widget.news.imageUrl,
                                                );
                                            try {
                                              await launchUrl(
                                                Uri.parse(videoUrl),
                                              );
                                            } catch (e) {
                                              print(
                                                'Failed to open video in external player: $e',
                                              );
                                            }
                                          }
                                        },
                                      );
                                    },
                                    child: Container(
                                      padding: EdgeInsets.all(20),
                                      decoration: BoxDecoration(
                                        color: Colors.black.withValues(
                                          alpha: 0.7,
                                        ),
                                        shape: BoxShape.circle,
                                      ),
                                      child: Icon(
                                        Icons.play_arrow,
                                        color: Colors.white,
                                        size: 60,
                                      ),
                                    ),
                                  ),
                                ),
                                Positioned(
                                  top: 10,
                                  right: 10,
                                  child: Container(
                                    padding: EdgeInsets.all(8),
                                    decoration: BoxDecoration(
                                      color: Colors.red,
                                      borderRadius: BorderRadius.circular(4),
                                    ),
                                    child: Icon(
                                      Icons.error,
                                      color: Colors.white,
                                      size: 20,
                                    ),
                                  ),
                                ),
                              ],
                            )
                          else
                            CachedNetworkImage(
                              imageUrl: NewsApiService.getFullImageUrl(
                                widget.news.imageUrl,
                              ),
                              width: double.infinity,
                              height: double.infinity,
                              fit: BoxFit.fitWidth,
                              alignment: Alignment.topCenter,
                              placeholder:
                                  (context, url) => Shimmer.fromColors(
                                    baseColor: Colors.grey[800]!,
                                    highlightColor: Colors.grey[700]!,
                                    child: Container(
                                      color: Colors.grey[800],
                                      width: double.infinity,
                                      height: double.infinity,
                                    ),
                                  ),
                              errorWidget:
                                  (context, url, error) => Container(
                                    color: Colors.grey[800],
                                    child: Center(
                                      child: Icon(
                                        Icons.error,
                                        color: Colors.white,
                                        size: 50,
                                      ),
                                    ),
                                  ),
                            ),

                          if (_showOverlay)
                            Positioned(
                              top: 0,
                              left: 0,
                              right: 0,
                              child: FadeTransition(
                                opacity: _fadeAnimation,
                                child: Container(
                                  padding: EdgeInsets.only(
                                    top:
                                        MediaQuery.of(context).padding.top + 12,
                                    left: 16,
                                    right: 16,
                                    bottom: 16,
                                  ),
                                  decoration: BoxDecoration(
                                    gradient: LinearGradient(
                                      begin: Alignment.topCenter,
                                      end: Alignment.bottomCenter,
                                      colors: [
                                        Colors.black.withValues(alpha: 0.95),
                                        Colors.black.withValues(alpha: 0.7),
                                        Colors.transparent,
                                      ],
                                      stops: [0.0, 0.6, 1.0],
                                    ),
                                  ),
                                  child: Row(
                                    mainAxisAlignment:
                                        MainAxisAlignment.spaceBetween,
                                    children: [
                                      GestureDetector(
                                        child: Container(
                                          padding: EdgeInsets.all(10),
                                          decoration: BoxDecoration(
                                            color: Colors.white.withValues(
                                              alpha: 0.15,
                                            ),
                                            shape: BoxShape.circle,
                                            border: Border.all(
                                              color: Colors.white.withValues(
                                                alpha: 0.3,
                                              ),
                                              width: 1,
                                            ),
                                          ),
                                          child: Icon(
                                            Icons.person_outline_rounded,
                                            color: Colors.white,
                                            size: 22,
                                          ),
                                        ),
                                        onTap: () {
                                          // Check if user is authenticated
                                          if (MobileAuthService.isSignedIn) {
                                            // User is logged in, go to profile page
                                            if (mounted) {
                                              Navigator.push(
                                                context,
                                                MaterialPageRoute(
                                                  builder:
                                                      (context) =>
                                                          ProfilePage(),
                                                ),
                                              );
                                            }
                                          } else {
                                            // User is not logged in, go to welcome screen for login
                                            if (mounted) {
                                              Navigator.pushNamed(
                                                context,
                                                '/welcome',
                                              );
                                            }
                                          }
                                        },
                                      ),

                                      Spacer(),

                                      GestureDetector(
                                        onTap: _showLocationSelector,
                                        child: Container(
                                          padding: EdgeInsets.symmetric(
                                            horizontal: 14,
                                            vertical: 8,
                                          ),
                                          decoration: BoxDecoration(
                                            gradient: LinearGradient(
                                              colors: [
                                                Color(
                                                  0xFFFF6B6B,
                                                ).withValues(alpha: 0.5),
                                                Color(
                                                  0xFFFF8E53,
                                                ).withValues(alpha: 0.4),
                                              ],
                                              begin: Alignment.topLeft,
                                              end: Alignment.bottomRight,
                                            ),
                                            borderRadius: BorderRadius.circular(
                                              20,
                                            ),
                                            border: Border.all(
                                              color: Colors.white.withValues(
                                                alpha: 0.4,
                                              ),
                                              width: 1.5,
                                            ),
                                            boxShadow: [
                                              BoxShadow(
                                                color: Color(
                                                  0xFFFF6B6B,
                                                ).withValues(alpha: 0.4),
                                                blurRadius: 12,
                                                offset: Offset(0, 4),
                                              ),
                                            ],
                                          ),
                                          child: Row(
                                            mainAxisSize: MainAxisSize.min,
                                            children: [
                                              Container(
                                                padding: EdgeInsets.all(4),
                                                decoration: BoxDecoration(
                                                  color: Colors.white
                                                      .withValues(alpha: 0.25),
                                                  shape: BoxShape.circle,
                                                ),
                                                child: Icon(
                                                  Icons.location_on_rounded,
                                                  color: Colors.white,
                                                  size: 16,
                                                ),
                                              ),
                                              SizedBox(width: 8),
                                              Text(
                                                widget.selectedLocation,
                                                style: TextStyle(
                                                  color: Colors.white,
                                                  fontSize: 15,
                                                  fontWeight: FontWeight.w600,
                                                  letterSpacing: 0.3,
                                                ),
                                              ),
                                              SizedBox(width: 4),
                                              Icon(
                                                Icons
                                                    .keyboard_arrow_down_rounded,
                                                color: Colors.white,
                                                size: 20,
                                              ),
                                            ],
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            ),

                          if (widget.news.mediaType == 'video' &&
                              _isVideoInitialized &&
                              _videoController != null)
                            Positioned(
                              bottom: 0,
                              left: 0,
                              right: 0,
                              child: AnimatedOpacity(
                                opacity: _showVideoControls ? 1.0 : 0.0,
                                duration: Duration(milliseconds: 300),
                                child: Container(
                                  padding: EdgeInsets.all(16),
                                  decoration: BoxDecoration(
                                    gradient: LinearGradient(
                                      begin: Alignment.bottomCenter,
                                      end: Alignment.topCenter,
                                      colors: [
                                        Colors.black.withValues(alpha: 0.8),
                                        Colors.transparent,
                                      ],
                                    ),
                                  ),
                                  child: Row(
                                    mainAxisAlignment:
                                        MainAxisAlignment.spaceBetween,
                                    children: [
                                      GestureDetector(
                                        onTap: () {
                                          if (_videoController!.value.volume ==
                                              0) {
                                            _videoController!.setVolume(1.0);
                                          } else {
                                            _videoController!.setVolume(0.0);
                                          }
                                          setState(() {});
                                        },
                                        child: Container(
                                          padding: EdgeInsets.all(8),
                                          decoration: BoxDecoration(
                                            color: Colors.black.withValues(
                                              alpha: 0.5,
                                            ),
                                            shape: BoxShape.circle,
                                          ),
                                          child: Icon(
                                            _videoController!.value.volume == 0
                                                ? Icons.volume_off
                                                : Icons.volume_up,
                                            color: Colors.white,
                                            size: 24,
                                          ),
                                        ),
                                      ),
                                      Expanded(
                                        child: SliderTheme(
                                          data: SliderTheme.of(
                                            context,
                                          ).copyWith(
                                            activeTrackColor: Colors.red,
                                            inactiveTrackColor: Colors.white38,
                                            thumbColor: Colors.red,
                                            thumbShape: RoundSliderThumbShape(
                                              enabledThumbRadius: 6,
                                            ),
                                            overlayShape:
                                                RoundSliderOverlayShape(
                                                  overlayRadius: 12,
                                                ),
                                          ),
                                          child: Slider(
                                            value:
                                                _videoController!
                                                    .value
                                                    .position
                                                    .inMilliseconds
                                                    .toDouble(),
                                            min: 0.0,
                                            max:
                                                _videoController!
                                                    .value
                                                    .duration
                                                    .inMilliseconds
                                                    .toDouble(),
                                            onChanged: (value) {
                                              final duration = Duration(
                                                milliseconds: value.toInt(),
                                              );
                                              _videoController!.seekTo(
                                                duration,
                                              );
                                            },
                                          ),
                                        ),
                                      ),
                                      GestureDetector(
                                        onTap: () {
                                          if (mounted) {
                                            Navigator.push(
                                              context,
                                              MaterialPageRoute(
                                                builder:
                                                    (context) =>
                                                        FullscreenVideoPlayer(
                                                          news: widget.news,
                                                          videoController:
                                                              _videoController,
                                                        ),
                                              ),
                                            );
                                          }
                                        },
                                        child: Container(
                                          padding: EdgeInsets.all(8),
                                          decoration: BoxDecoration(
                                            color: Colors.black.withValues(
                                              alpha: 0.5,
                                            ),
                                            shape: BoxShape.circle,
                                          ),
                                          child: Icon(
                                            Icons.fullscreen,
                                            color: Colors.white,
                                            size: 24,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            ),

                          if (widget.news.mediaType != 'video')
                            Positioned(
                              bottom:
                                  widget.news.mediaType == 'video' &&
                                          _isVideoInitialized &&
                                          _videoController != null &&
                                          _videoController!.value.isPlaying
                                      ? -40
                                      : 10,
                              right: 10,
                              child: AnimatedContainer(
                                duration: Duration(milliseconds: 300),
                                child: Container(
                                  padding: EdgeInsets.symmetric(
                                    horizontal: 8,
                                    vertical: 4,
                                  ),
                                  decoration: BoxDecoration(
                                    color: Colors.black54,
                                    borderRadius: BorderRadius.circular(4),
                                  ),
                                  child: Image.asset(
                                    'assets/images/web-logo.png',
                                    height: 24,
                                    fit: BoxFit.contain,
                                  ),
                                ),
                              ),
                            ),

                          // More options button in image center-right - only show if dynamic links exist
                          if (widget.news.readFullLink != null ||
                              widget.news.ePaperLink != null)
                            Positioned(
                              right: 8,
                              top: 220,
                              bottom: 0,
                              child: Center(
                                child: _MoreOptionsButton(
                                  hasReadFullLink:
                                      widget.news.readFullLink != null,
                                  hasEPaperLink: widget.news.ePaperLink != null,
                                  onReadMore: () async {
                                    // Use custom link if available, otherwise use default
                                    final urlString =
                                        widget.news.readFullLink ??
                                        'https://www.a1telugunews.com';
                                    print('Opening Read Full link: $urlString');
                                    print(
                                      'Custom link from news: ${widget.news.readFullLink}',
                                    );
                                    final url = Uri.parse(urlString);
                                    try {
                                      if (await canLaunchUrl(url)) {
                                        await launchUrl(
                                          url,
                                          mode: LaunchMode.externalApplication,
                                        );
                                      }
                                    } catch (e) {
                                      print('Error opening news website: $e');
                                    }
                                  },
                                  onEPaper: () async {
                                    // Use custom link if available, otherwise use default
                                    final urlString =
                                        widget.news.ePaperLink ??
                                        'https://epaper.a1telugunews.com';
                                    print('Opening ePaper link: $urlString');
                                    print(
                                      'Custom ePaper link from news: ${widget.news.ePaperLink}',
                                    );
                                    final url = Uri.parse(urlString);
                                    try {
                                      if (await canLaunchUrl(url)) {
                                        await launchUrl(
                                          url,
                                          mode: LaunchMode.externalApplication,
                                        );
                                      }
                                    } catch (e) {
                                      print('Error opening ePaper: $e');
                                    }
                                  },
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                  Expanded(
                    flex: 7, // 35% of screen for content
                    child: Container(
                      width: double.infinity,
                      padding: EdgeInsets.all(16),
                      color: Colors.white,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            widget.news.title,
                            style: TextStyle(
                              fontSize: 22,
                              fontWeight: FontWeight.bold,
                              color: Colors.black87,
                              height: 1.3,
                              fontFamily: 'TeluguFont',
                            ),
                            maxLines: null,
                          ),
                          SizedBox(height: 12),
                          Flexible(
                            child: Text(
                              widget.news.content,
                              style: TextStyle(
                                fontSize: 17,
                                color: Colors.black87,
                                height: 1.5,
                                fontFamily: 'TeluguFont',
                                fontWeight: FontWeight.w500,
                              ),
                              maxLines: null,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),

              Positioned(
                bottom: 0,
                left: 0,
                right: 0,
                child: Visibility(
                  visible: !_showOverlay,
                  child: Material(
                    elevation: 8.0,
                    color: Colors.white,
                    child: Container(
                      padding: EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 12,
                      ),
                      child: Column(
                        children: [
                          Align(
                            alignment: Alignment.centerLeft,
                            child: Text(
                              '${widget.news.timeAgo} / ${widget.news.category}',
                              style: TextStyle(
                                color: Colors.grey[600],
                                fontSize: 14,
                                fontFamily: 'TeluguFont',
                              ),
                            ),
                          ),
                          SizedBox(height: 10),
                          Container(height: 1, color: Colors.grey[300]),
                          SizedBox(height: 10),
                          Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              Row(
                                children: [
                                  _buildInteractionButton(
                                    icon:
                                        _isLiked
                                            ? Icons.thumb_up
                                            : Icons.thumb_up_outlined,
                                    count: _formatCount(_likeCount),
                                    onTap: _handleLike,
                                  ),
                                  SizedBox(width: 20),
                                  _buildInteractionButton(
                                    icon:
                                        _isDisliked
                                            ? Icons.thumb_down
                                            : Icons.thumb_down_outlined,
                                    count: _formatCount(_dislikeCount),
                                    onTap: _handleDislike,
                                  ),
                                  SizedBox(width: 20),
                                  _buildInteractionButton(
                                    icon: Icons.comment_outlined,
                                    count: _formatCount(widget.news.comments),
                                    onTap: () async {
                                      await _showCommentSheet(context);
                                    },
                                  ),
                                  SizedBox(width: 20),
                                  // Voice/TTS Button
                                  _buildInteractionButton(
                                    icon:
                                        _isSpeaking
                                            ? Icons.stop_circle
                                            : Icons.volume_up_outlined,
                                    count: '',
                                    onTap: _handleVoiceButton,
                                    color: _isSpeaking ? Colors.red : null,
                                  ),
                                ],
                              ),
                              Row(
                                children: [
                                  GestureDetector(
                                    onTap: _showPopupMenu,
                                    child: Container(
                                      padding: EdgeInsets.symmetric(
                                        horizontal: 8,
                                        vertical: 6,
                                      ),
                                      child: Icon(
                                        Icons.more_vert,
                                        color: Colors.grey[600],
                                        size: 26,
                                      ),
                                    ),
                                  ),
                                  _buildInteractionButton(
                                    icon: Icons.share,
                                    count: '',
                                    onTap: () => _shareNews(context),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),

              if (_showOverlay)
                Positioned(
                  bottom: 0,
                  left: 0,
                  right: 0,
                  child: FadeTransition(
                    opacity: _fadeAnimation,
                    child: Container(
                      padding: EdgeInsets.only(
                        bottom: MediaQuery.of(context).padding.bottom + 12,
                        top: 12,
                        left: 12,
                        right: 12,
                      ),
                      decoration: BoxDecoration(color: Colors.transparent),
                      child: Container(
                        padding: EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 10,
                        ),
                        decoration: BoxDecoration(
                          color: Colors.black.withValues(alpha: 0.8),
                          borderRadius: BorderRadius.circular(20),
                          border: Border.all(
                            color: Colors.white.withValues(alpha: 0.2),
                            width: 1,
                          ),
                        ),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.spaceAround,
                          children: [
                            _buildBottomNavItem(
                              icon: Icons.description_outlined,
                              label: 'న్యూస్',
                              onTap: () {},
                            ),
                            _buildBottomNavItemWithCount(
                              icon: Icons.visibility,
                              label: 'Unread',
                              count: _unreadNewsCount,
                            ),
                            _buildBottomNavItem(
                              icon: Icons.local_fire_department_outlined,
                              label: 'వైరల్',
                              onTap: () {
                                Navigator.push(
                                  context,
                                  MaterialPageRoute(
                                    builder:
                                        (context) => const ViralVideosScreen(),
                                  ),
                                );
                              },
                            ),
                            _buildBottomNavItem(
                              icon: Icons.refresh_outlined,
                              label: 'రీలోడ్',
                              onTap: widget.onRefresh,
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildBottomNavItem({
    required IconData icon,
    required String label,
    required VoidCallback onTap,
  }) {
    return GestureDetector(
      onTap: () async {
        if (icon == Icons.refresh_outlined) {
          setState(() {
            _isRefreshing = true;
          });

          // Call the refresh function
          onTap();

          // Reset the page controller to show news from the beginning
          // We need to access the page controller from the parent widget
          // For now, we'll just wait a bit and then hide the refresh indicator
          await Future.delayed(Duration(milliseconds: 500));

          if (mounted) {
            setState(() {
              _isRefreshing = false;
            });
          }
        } else {
          onTap();
        }
      },
      child: Container(
        padding: EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              padding: EdgeInsets.all(8),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [
                    Colors.white.withValues(alpha: 0.2),
                    Colors.white.withValues(alpha: 0.1),
                  ],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(14),
                border: Border.all(
                  color: Colors.white.withValues(alpha: 0.25),
                  width: 1.2,
                ),
              ),
              child:
                  _isRefreshing && icon == Icons.refresh_outlined
                      ? SizedBox(
                        width: 22,
                        height: 22,
                        child: CircularProgressIndicator(
                          valueColor: AlwaysStoppedAnimation<Color>(
                            Colors.white,
                          ),
                          strokeWidth: 2,
                        ),
                      )
                      : Icon(icon, color: Colors.white, size: 22),
            ),
            SizedBox(height: 6),
            Text(
              label,
              style: TextStyle(
                color: Colors.white,
                fontSize: 14,
                fontWeight: FontWeight.w600,
                fontFamily: 'TeluguFont',
                shadows: [
                  Shadow(
                    color: Colors.black.withValues(alpha: 0.5),
                    offset: Offset(0, 1),
                    blurRadius: 3,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildInteractionButton({
    required IconData icon,
    required String count,
    required VoidCallback onTap,
    bool isEnabled = true,
    Color? color, // Optional color parameter
  }) {
    if (icon == Icons.share && _isCapturingScreenshot) {
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(
              valueColor: AlwaysStoppedAnimation<Color>(Colors.grey[600]!),
              strokeWidth: 2,
            ),
          ),
          SizedBox(width: 4),
          Text(
            'Sharing...',
            style: TextStyle(
              color: Colors.grey[600],
              fontSize: 14,
              fontWeight: FontWeight.w500,
              fontFamily: 'TeluguFont',
            ),
          ),
        ],
      );
    }

    return GestureDetector(
      onTap: isEnabled ? onTap : null,
      child: Container(
        padding: EdgeInsets.symmetric(horizontal: 0, vertical: 0),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              icon,
              color: color ?? (isEnabled ? Colors.grey[600] : Colors.grey[400]),
              size: 25,
            ),
            if (count.isNotEmpty) ...[
              SizedBox(width: 6),
              Text(
                count,
                style: TextStyle(
                  color: isEnabled ? Colors.grey[600] : Colors.grey[400],
                  fontSize: 14,
                  fontWeight: FontWeight.w500,
                  fontFamily: 'TeluguFont',
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  String _formatCount(int count) {
    if (count >= 1000) return '${(count / 1000).toStringAsFixed(1)}k';
    return count.toString();
  }

  String _formatDuration(Duration duration) {
    String twoDigits(int n) => n.toString().padLeft(2, "0");
    String twoDigitMinutes = twoDigits(duration.inMinutes.remainder(60));
    String twoDigitSeconds = twoDigits(duration.inSeconds.remainder(60));
    if (duration.inHours > 0) {
      return "${twoDigits(duration.inHours)}:$twoDigitMinutes:$twoDigitSeconds";
    } else {
      return "$twoDigitMinutes:$twoDigitSeconds";
    }
  }

  void _showPopupMenu() async {
    // Capture the outer context for ScaffoldMessenger
    final outerContext = context;

    await showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      builder:
          (context) => Container(
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  margin: EdgeInsets.only(top: 8),
                  height: 4,
                  width: 40,
                  decoration: BoxDecoration(
                    color: Colors.grey[300],
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
                Padding(
                  padding: EdgeInsets.all(20),
                  child: Text(
                    'More Options',
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.bold,
                      fontFamily: 'TeluguFont',
                    ),
                  ),
                ),
                _buildPopupMenuItem(
                  Icons.play_circle_outline,
                  'Viral Videos',
                  () {
                    if (mounted) {
                      Navigator.pop(context);
                    }
                    Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (context) => const ViralVideosScreen(),
                      ),
                    );
                  },
                ),
                _buildPopupMenuItem(Icons.report, 'Report', () {
                  if (mounted) {
                    Navigator.pop(context);
                  }
                  // TODO: Implement report functionality
                  _showReportDialog();
                }),
                _buildPopupMenuItem(
                  _isBookmarked ? Icons.bookmark : Icons.bookmark_border,
                  _isBookmarked ? 'Remove Bookmark' : 'Bookmark',
                  () async {
                    if (mounted) {
                      Navigator.pop(context);
                    }
                    // Implement bookmark functionality
                    await _toggleBookmark();
                    if (mounted) {
                      ScaffoldMessenger.of(outerContext).showSnackBar(
                        SnackBar(
                          content: Text(
                            _isBookmarked
                                ? 'Removed from bookmarks'
                                : 'Added to bookmarks',
                          ),
                        ),
                      );
                    }
                  },
                ),
                _buildPopupMenuItem(Icons.share, 'Share', () {
                  if (mounted) {
                    Navigator.pop(context);
                  }
                  _shareNews(outerContext);
                }),
                SizedBox(height: 20),
              ],
            ),
          ),
    );
  }

  Widget _buildPopupMenuItem(IconData icon, String title, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: double.infinity,
        padding: EdgeInsets.all(16),
        child: Row(
          children: [
            Icon(icon, color: Colors.black87, size: 24),
            SizedBox(width: 16),
            Text(
              title,
              style: TextStyle(
                fontSize: 16,
                color: Colors.black87,
                fontWeight: FontWeight.w500,
                fontFamily: 'TeluguFont',
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _showReportDialog() async {
    // Check authentication first
    final isAuthorized = await AuthUtils.showAuthBottomSheetIfNeeded(
      context,
      MobileAuthService.instance.isAuthenticated,
    );

    if (!isAuthorized) return;

    final reportReasons = [
      'Inappropriate content',
      'False information',
      'Copyright violation',
      'Spam',
      'Other',
    ];

    String selectedReason = reportReasons[0];
    final descriptionController = TextEditingController();

    // Capture the outer context for ScaffoldMessenger
    final outerContext = context;

    showDialog(
      context: context,
      builder: (BuildContext context) {
        return StatefulBuilder(
          builder: (context, setState) {
            return AlertDialog(
              title: Text('Report News'),
              content: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Why are you reporting this news?'),
                  SizedBox(height: 10),
                  DropdownButton<String>(
                    isExpanded: true,
                    value: selectedReason,
                    items:
                        reportReasons.map((String reason) {
                          return DropdownMenuItem<String>(
                            value: reason,
                            child: Text(reason),
                          );
                        }).toList(),
                    onChanged: (String? newValue) {
                      setState(() {
                        selectedReason = newValue!;
                      });
                    },
                  ),
                  SizedBox(height: 10),
                  TextField(
                    controller: descriptionController,
                    maxLines: 3,
                    decoration: InputDecoration(
                      hintText: 'Additional details (optional)',
                      border: OutlineInputBorder(),
                    ),
                  ),
                ],
              ),
              actions: [
                TextButton(
                  onPressed: () {
                    if (mounted) {
                      Navigator.of(context).pop();
                    }
                  },
                  child: Text('Cancel'),
                ),
                TextButton(
                  onPressed: () async {
                    if (mounted) {
                      Navigator.of(context).pop();
                    }

                    // Show loading indicator using outer context
                    if (mounted) {
                      ScaffoldMessenger.of(outerContext).showSnackBar(
                        SnackBar(content: Text('Submitting report...')),
                      );
                    }

                    try {
                      final result = await NewsApiService.reportNews(
                        widget.news.id,
                        selectedReason,
                        descriptionController.text,
                      );

                      // Show result using outer context
                      if (mounted) {
                        ScaffoldMessenger.of(outerContext).showSnackBar(
                          SnackBar(content: Text(result['message'])),
                        );
                      }
                    } catch (e) {
                      if (mounted) {
                        ScaffoldMessenger.of(outerContext).showSnackBar(
                          SnackBar(content: Text('Error reporting news: $e')),
                        );
                      }
                    }
                  },
                  child: Text('Submit'),
                ),
              ],
            );
          },
        );
      },
    );
  }

  void _showLocationSelector() {
    SystemChrome.setSystemUIOverlayStyle(
      SystemUiOverlayStyle.light.copyWith(
        statusBarColor: Colors.transparent,
        systemNavigationBarColor: Colors.black,
        systemNavigationBarIconBrightness: Brightness.light,
      ),
    );

    // Capture the outer context for ScaffoldMessenger
    final outerContext = context;

    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      builder:
          (context) => Container(
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  margin: EdgeInsets.only(top: 8),
                  height: 4,
                  width: 40,
                  decoration: BoxDecoration(
                    color: Colors.grey[300],
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
                Padding(
                  padding: EdgeInsets.all(20),
                  child: Text(
                    'స్థానం ఎంచుకోండి',
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.bold,
                      fontFamily: 'TeluguFont',
                    ),
                  ),
                ),
                FutureBuilder<List<Map<String, dynamic>>>(
                  future: NewsApiService.fetchLocations(),
                  builder: (context, snapshot) {
                    if (snapshot.connectionState == ConnectionState.waiting) {
                      return Center(
                        child: Padding(
                          padding: EdgeInsets.all(20),
                          child: CircularProgressIndicator(),
                        ),
                      );
                    }

                    if (snapshot.hasError) {
                      return Center(
                        child: Padding(
                          padding: EdgeInsets.all(20),
                          child: Text('Failed to load locations'),
                        ),
                      );
                    }

                    if (!snapshot.hasData || snapshot.data!.isEmpty) {
                      return Center(
                        child: Padding(
                          padding: EdgeInsets.all(20),
                          child: Text('No locations available'),
                        ),
                      );
                    }

                    final locations = snapshot.data!;

                    return Column(
                      children: [
                        _buildLocationOption('All', 'అన్నీ'),
                        ...locations.map((location) {
                          String locationName = location['name'] ?? 'Unknown';
                          String teluguName =
                              location['teluguName'] ?? locationName;
                          return _buildLocationOption(locationName, teluguName);
                        }).toList(),
                      ],
                    );
                  },
                ),
                SizedBox(height: 20),
              ],
            ),
          ),
    );
  }

  Widget _buildLocationOption(String location, String teluguName) {
    bool isSelected = widget.selectedLocation == location;
    return GestureDetector(
      onTap: () {
        if (mounted) {
          Navigator.pop(context);
          widget.onLocationChanged(location);
        }
      },
      child: Container(
        margin: EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        padding: EdgeInsets.all(16),
        decoration: BoxDecoration(
          gradient:
              isSelected
                  ? LinearGradient(
                    colors: [
                      Color(0xFFFF6B6B).withValues(alpha: 0.15),
                      Color(0xFFFF8E53).withValues(alpha: 0.1),
                    ],
                  )
                  : null,
          color: isSelected ? null : Colors.grey[50],
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: isSelected ? Color(0xFFFF6B6B) : Colors.grey[300]!,
            width: isSelected ? 2 : 1,
          ),
        ),
        child: Row(
          children: [
            Container(
              padding: EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: isSelected ? Color(0xFFFF6B6B) : Colors.grey[300],
                shape: BoxShape.circle,
              ),
              child: Icon(
                isSelected ? Icons.check : Icons.location_on_outlined,
                color: isSelected ? Colors.white : Colors.grey[600],
                size: 20,
              ),
            ),
            SizedBox(width: 16),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  location,
                  style: TextStyle(
                    fontSize: 16,
                    color: isSelected ? Color(0xFFFF6B6B) : Colors.black87,
                    fontWeight: isSelected ? FontWeight.bold : FontWeight.w500,
                    fontFamily: 'TeluguFont',
                  ),
                ),
                Text(
                  teluguName,
                  style: TextStyle(
                    fontSize: 13,
                    color: Colors.grey[600],
                    fontWeight: FontWeight.w400,
                    fontFamily: 'TeluguFont',
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  void _shareNews(BuildContext context) async {
    // Show loading indicator
    setState(() {
      _isCapturingScreenshot = true;
    });

    try {
      print('Starting screenshot capture process...');

      // Make sure overlay is visible for the screenshot
      bool wasOverlayVisible = _showOverlay;
      if (!wasOverlayVisible) {
        setState(() {
          _showOverlay = true;
        });
        // Give time for the overlay to appear
        await Future.delayed(Duration(milliseconds: 300));
      }

      // Capture screenshot of the current news card
      final image = await _screenshotController.capture(
        delay: Duration(milliseconds: 200),
        pixelRatio: 1.5,
      );

      print(
        'Screenshot capture completed. Image data: ${image != null ? 'Available' : 'Null'}',
      );

      // Create share text with ONLY news title and link (without "Read more" text and extra spaces)
      // Ensure we handle potential null values in the title
      String newsTitle =
          widget.news.title.isNotEmpty ? widget.news.title : 'News Article';
      String shareText =
          "$newsTitle\n${NewsApiService.getFullImageUrl('/news/${widget.news.id}')}";

      // Restore previous overlay state
      if (!wasOverlayVisible && mounted) {
        setState(() {
          _showOverlay = false;
        });
      }

      if (image != null) {
        try {
          print('Saving screenshot to temporary file...');
          // Save the image to a temporary file
          final directory = await getTemporaryDirectory();
          final imagePath = '${directory.path}/news_${widget.news.id}.png';
          final imageFile = File(imagePath);
          await imageFile.writeAsBytes(image);
          print('Screenshot saved to: $imagePath');

          // Hide loading indicator
          if (mounted) {
            setState(() {
              _isCapturingScreenshot = false;
            });
          }

          print('Sharing screenshot and text...');
          // Share both the image and text
          await Share.shareFiles(
            [imagePath],
            text: shareText,
            subject: newsTitle,
          );
          print('Screenshot shared successfully');
        } catch (e) {
          print('Error sharing image: $e');
          // Hide loading indicator
          if (mounted) {
            setState(() {
              _isCapturingScreenshot = false;
            });
          }
          // Fallback to text-only sharing if image sharing fails
          Share.share(shareText, subject: newsTitle);
        }
      } else {
        print(
          'Screenshot capture returned null, falling back to text-only sharing',
        );
        // Hide loading indicator
        if (mounted) {
          setState(() {
            _isCapturingScreenshot = false;
          });
        }
        // Fallback to text-only sharing if screenshot capture fails
        Share.share(shareText, subject: newsTitle);
      }
    } catch (e) {
      print('Error capturing screenshot: $e');
      // Hide loading indicator
      if (mounted) {
        setState(() {
          _isCapturingScreenshot = false;
        });
      }
      // Fallback to text-only sharing if screenshot capture fails
      String newsTitle =
          widget.news.title.isNotEmpty ? widget.news.title : 'News Article';
      String shareText =
          "$newsTitle\n${NewsApiService.getFullImageUrl('/news/${widget.news.id}')}";
      Share.share(shareText, subject: newsTitle);
    }
  }

  int _getUnreadNewsCount() {
    return widget.allNewsList.where((news) => !news.isRead).length;
  }

  Widget _buildBottomNavItemWithCount({
    required IconData icon,
    required String label,
    required int count,
  }) {
    return GestureDetector(
      onTap: () {
        if (mounted) {
          Navigator.push(
            context,
            MaterialPageRoute(
              builder:
                  (context) => UnreadNewsScreen(
                    allNewsList: widget.allNewsList,
                    onNewsInteraction: widget.onInteraction,
                    onRefresh: widget.onRefresh,
                    onLocationChanged: widget.onLocationChanged,
                    selectedLocation: widget.selectedLocation,
                    onResetReadStatus: widget.onResetReadStatus,
                    onShowUnreadNews: widget.onShowUnreadNews,
                    onMarkAllAsRead: widget.onMarkAllAsRead,
                    onShowAllNews: widget.onShowAllNews,
                  ),
            ),
          ).then((_) {
            // Refresh unread count when returning from UnreadNewsScreen
            _loadUnreadNewsCount();
          });
        }
      },
      onLongPress: () {
        if (mounted) {
          showDialog(
            context: context,
            builder: (BuildContext context) {
              return AlertDialog(
                title: Text('Unread News Options'),
                content: Text('Choose an option:'),
                actions: [
                  TextButton(
                    onPressed: () {
                      if (mounted) {
                        Navigator.of(context).pop();
                      }
                      widget.onShowAllNews();
                    },
                    child: Text('Show All News'),
                  ),
                  TextButton(
                    onPressed: () {
                      if (mounted) {
                        Navigator.of(context).pop();
                      }
                      widget.onMarkAllAsRead();
                    },
                    child: Text('Mark All as Read'),
                  ),
                ],
              );
            },
          ).then((_) {
            // Refresh unread count after dialog actions
            _loadUnreadNewsCount();
          });
        }
      },
      child: Container(
        padding: EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              padding: EdgeInsets.all(8),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [
                    Colors.white.withValues(alpha: 0.2),
                    Colors.white.withValues(alpha: 0.1),
                  ],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(14),
                border: Border.all(
                  color: Colors.white.withValues(alpha: 0.25),
                  width: 1.2,
                ),
              ),
              child: Stack(
                clipBehavior: Clip.none,
                children: [
                  Icon(icon, color: Colors.white, size: 22),
                  if (count > 0)
                    Positioned(
                      right: -2,
                      top: -2,
                      child: Container(
                        padding: EdgeInsets.all(4),
                        decoration: BoxDecoration(
                          color: Colors.red,
                          shape: BoxShape.circle,
                        ),
                        constraints: BoxConstraints(
                          minWidth: 16,
                          minHeight: 16,
                        ),
                        child: Text(
                          count > 99 ? '99+' : count.toString(),
                          style: TextStyle(
                            color: Colors.white,
                            fontSize: 10,
                            fontWeight: FontWeight.bold,
                          ),
                          textAlign: TextAlign.center,
                        ),
                      ),
                    ),
                ],
              ),
            ),
            SizedBox(height: 6),
            Text(
              label,
              style: TextStyle(
                color: Colors.white,
                fontSize: 14,
                fontWeight: FontWeight.w600,
                fontFamily: 'TeluguFont',
                shadows: [
                  Shadow(
                    color: Colors.black.withValues(alpha: 0.5),
                    offset: Offset(0, 1),
                    blurRadius: 3,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  // Check if the current user has liked this news
  bool _hasLiked() {
    final userId = MobileAuthService.getUserId();
    if (userId == null) return false;

    return widget.news.userLikes.any((like) => like.userId == userId);
  }

  // Check if the current user has disliked this news
  bool _hasDisliked() {
    final userId = MobileAuthService.getUserId();
    if (userId == null) return false;

    return widget.news.userDislikes.any((dislike) => dislike.userId == userId);
  }

  // Get the appropriate icon for the like button based on user's interaction
  IconData _getLikeIcon() {
    if (_hasLiked()) {
      return Icons.thumb_up; // Filled icon for liked
    }
    return Icons.thumb_up_outlined; // Outlined icon for not liked
  }

  // Get the appropriate icon for the dislike button based on user's interaction
  IconData _getDislikeIcon() {
    if (_hasDisliked()) {
      return Icons.thumb_down; // Filled icon for disliked
    }
    return Icons.thumb_down_outlined; // Outlined icon for not disliked
  }
}

// More Options Button Widget
class _MoreOptionsButton extends StatefulWidget {
  final bool hasReadFullLink;
  final bool hasEPaperLink;
  final VoidCallback onReadMore;
  final VoidCallback onEPaper;

  const _MoreOptionsButton({
    required this.hasReadFullLink,
    required this.hasEPaperLink,
    required this.onReadMore,
    required this.onEPaper,
  });

  @override
  State<_MoreOptionsButton> createState() => _MoreOptionsButtonState();
}

class _MoreOptionsButtonState extends State<_MoreOptionsButton>
    with SingleTickerProviderStateMixin {
  bool _isExpanded = false;
  late AnimationController _animationController;

  @override
  void initState() {
    super.initState();
    _animationController = AnimationController(
      duration: Duration(milliseconds: 300),
      vsync: this,
    );
  }

  @override
  void dispose() {
    _animationController.dispose();
    super.dispose();
  }

  void _toggleMenu() {
    setState(() {
      _isExpanded = !_isExpanded;
      if (_isExpanded) {
        _animationController.forward();
      } else {
        _animationController.reverse();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () {
        // Close menu when tapping outside
        if (_isExpanded) {
          _toggleMenu();
        }
      },
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Expanded menu options
          AnimatedSize(
            duration: Duration(milliseconds: 300),
            curve: Curves.easeInOut,
            child:
                _isExpanded
                    ? Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        // Read Full Article option - only show if link exists
                        if (widget.hasReadFullLink) ...[
                          _buildMenuOption(
                            icon: Icons.article_outlined,
                            label: 'Read Full',
                            gradient: LinearGradient(
                              colors: [Color(0xFF4A90E2), Color(0xFF357ABD)],
                              begin: Alignment.topLeft,
                              end: Alignment.bottomRight,
                            ),
                            onTap: () {
                              _toggleMenu();
                              widget.onReadMore();
                            },
                          ),
                          SizedBox(height: 8),
                        ],
                        // View ePaper option - only show if link exists
                        if (widget.hasEPaperLink) ...[
                          _buildMenuOption(
                            icon: Icons.newspaper_outlined,
                            label: 'ePaper',
                            gradient: LinearGradient(
                              colors: [Color(0xFFE74C3C), Color(0xFFC0392B)],
                              begin: Alignment.topLeft,
                              end: Alignment.bottomRight,
                            ),
                            onTap: () {
                              _toggleMenu();
                              widget.onEPaper();
                            },
                          ),
                          SizedBox(height: 8),
                        ],
                      ],
                    )
                    : SizedBox.shrink(),
          ),
          // Main menu button
          GestureDetector(
            onTap: _toggleMenu,
            child: Container(
              width: 48,
              height: 48,
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [
                    Color(0xFFF7F301),
                    Color(0xFFFFD700),
                  ], // Bright yellow gradient
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(24),
                border: Border.all(
                  color: Colors.white,
                  width: 2.5, // White border for visibility
                ),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.4),
                    blurRadius: 8,
                    offset: Offset(0, 2),
                  ),
                  BoxShadow(
                    color: Color(0xFFF7F301).withValues(alpha: 0.6),
                    blurRadius: 16,
                    offset: Offset(0, 4),
                  ),
                ],
              ),
              child: AnimatedRotation(
                turns: _isExpanded ? 0.25 : 0,
                duration: Duration(milliseconds: 300),
                child: Icon(
                  Icons.more_vert,
                  color: Colors.black,
                  size: 24,
                ), // Black icon on yellow
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildMenuOption({
    required IconData icon,
    required String label,
    required Gradient gradient,
    required VoidCallback onTap,
  }) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 48,
        height: 48,
        decoration: BoxDecoration(
          gradient: gradient,
          borderRadius: BorderRadius.circular(24),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.2),
              blurRadius: 8,
              offset: Offset(0, 2),
            ),
          ],
        ),
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            Center(child: Icon(icon, color: Colors.white, size: 22)),
            // Label tooltip on the left
            Positioned(
              right: 56,
              top: 0,
              bottom: 0,
              child: Center(
                child: Container(
                  padding: EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  decoration: BoxDecoration(
                    color: Colors.black87,
                    borderRadius: BorderRadius.circular(8),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withValues(alpha: 0.3),
                        blurRadius: 8,
                        offset: Offset(0, 2),
                      ),
                    ],
                  ),
                  child: Text(
                    label,
                    style: TextStyle(
                      color: Colors.white,
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      fontFamily: 'TeluguFont',
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
