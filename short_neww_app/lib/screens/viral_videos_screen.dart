import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';
import 'package:youtube_player_flutter/youtube_player_flutter.dart';
import '../services/news_api_service.dart';

class ViralVideosScreen extends StatefulWidget {
  const ViralVideosScreen({Key? key}) : super(key: key);

  @override
  State<ViralVideosScreen> createState() => _ViralVideosScreenState();
}

class _ViralVideosScreenState extends State<ViralVideosScreen> {
  final PageController _pageController = PageController();
  List<Map<String, dynamic>> _videos = [];
  bool _isLoading = true;
  int _currentIndex = 0;
  final Map<int, VideoPlayerController?> _videoControllers = {};
  final Map<int, YoutubePlayerController?> _youtubeControllers = {};

  @override
  void initState() {
    super.initState();
    _loadVideos();
  }

  Future<void> _loadVideos() async {
    try {
      // Fetch viral videos from API
      final response = await NewsApiService.getViralVideos();
      setState(() {
        _videos = response;
        _isLoading = false;
      });

      // Initialize first video
      if (_videos.isNotEmpty) {
        _initializeVideo(0);
      }
    } catch (e) {
      print('Error loading viral videos: $e');
      setState(() {
        _isLoading = false;
      });
    }
  }

  void _initializeVideo(int index) {
    if (index < 0 || index >= _videos.length) return;
    if (_videoControllers[index] != null || _youtubeControllers[index] != null)
      return;

    final video = _videos[index];
    final videoUrl = video['mediaUrl'] ?? video['videoUrl'];

    if (videoUrl == null || videoUrl.isEmpty) return;

    // Initialize YouTube player for YouTube URLs
    final String url = videoUrl.toString();
    if (url.toLowerCase().contains('youtube.com') ||
        url.toLowerCase().contains('youtu.be')) {
      String? videoId = YoutubePlayer.convertUrlToId(url);

      // Manual fallback for Shorts if library fails
      if (videoId == null) {
        if (url.contains("shorts/")) {
          final parts = url.split("shorts/");
          if (parts.length > 1) {
            videoId = parts[1].split("?")[0].split("&")[0];
          }
        }
      }

      if (videoId != null && videoId.isNotEmpty) {
        final controller = YoutubePlayerController(
          initialVideoId: videoId,
          flags: const YoutubePlayerFlags(
            autoPlay: false,
            mute: false,
            disableDragSeek: false,
            loop: true,
            isLive: false,
            forceHD: false,
            enableCaption: false,
            hideControls: true,
          ),
        );

        setState(() {
          _youtubeControllers[index] = controller;
        });
      }
      return;
    }

    // Only initialize for uploaded videos (mediaUrl)
    if (video['mediaUrl'] != null) {
      final fullUrl = NewsApiService.getFullImageUrl(videoUrl);
      final controller = VideoPlayerController.networkUrl(
        Uri.parse(fullUrl),
        videoPlayerOptions: VideoPlayerOptions(
          mixWithOthers: false,
          allowBackgroundPlayback: false,
        ),
      );

      controller
          .initialize()
          .then((_) {
            if (mounted) {
              setState(() {
                _videoControllers[index] = controller;
              });
              controller.setLooping(true);
              if (index == _currentIndex) {
                controller.play();
              }
            }
          })
          .catchError((error) {
            print('Error initializing video: $error');
          });

      _videoControllers[index] = controller;
    }
  }

  void _onPageChanged(int index) {
    // Pause previous video
    _videoControllers[_currentIndex]?.pause();
    _videoControllers[_currentIndex]?.pause();
    if (_youtubeControllers[_currentIndex]?.value.isReady ?? false) {
      _youtubeControllers[_currentIndex]?.pause();
    }

    setState(() {
      _currentIndex = index;
    });

    // Play current video
    if (_videoControllers[index] != null) {
      _videoControllers[index]!.play();
    } else if (_youtubeControllers[index] != null) {
      // Check if ready before playing
      if (_youtubeControllers[index]!.value.isReady) {
        _youtubeControllers[index]!.play();
      }
    } else {
      _initializeVideo(index);
    }

    // Preload next video
    if (index + 1 < _videos.length) {
      _initializeVideo(index + 1);
    }
  }

  @override
  void dispose() {
    _pageController.dispose();
    for (var controller in _videoControllers.values) {
      controller?.dispose();
    }
    for (var controller in _youtubeControllers.values) {
      controller?.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body:
          _isLoading
              ? const Center(
                child: CircularProgressIndicator(color: Colors.white),
              )
              : _videos.isEmpty
              ? Center(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      Icons.video_library_outlined,
                      size: 64,
                      color: Colors.white54,
                    ),
                    SizedBox(height: 16),
                    Text(
                      'No viral videos yet',
                      style: TextStyle(color: Colors.white, fontSize: 18),
                    ),
                  ],
                ),
              )
              : PageView.builder(
                controller: _pageController,
                scrollDirection: Axis.vertical,
                onPageChanged: _onPageChanged,
                itemCount: _videos.length,
                itemBuilder: (context, index) {
                  return _buildVideoPage(_videos[index], index);
                },
              ),
    );
  }

  Widget _buildVideoPage(Map<String, dynamic> video, int index) {
    final videoController = _videoControllers[index];
    final youtubeController = _youtubeControllers[index];
    final hasUploadedVideo = video['mediaUrl'] != null;
    final isYoutubeVideo = youtubeController != null;

    return GestureDetector(
      onTap: () {
        if (videoController != null) {
          setState(() {
            if (videoController.value.isPlaying) {
              videoController.pause();
            } else {
              videoController.play();
            }
          });
        }
        // YouTube player handles its own taps mostly, but we can toggle play/pause via controller if needed
        // Typically YoutubePlayer captures gestures, so this might not be reached for YouTube videos
        // depending on how the widget is configured.
      },
      child: Stack(
        fit: StackFit.expand,
        children: [
          // Video Player or Placeholder
          if (hasUploadedVideo &&
              videoController != null &&
              videoController.value.isInitialized)
            Center(
              child: AspectRatio(
                aspectRatio: videoController.value.aspectRatio,
                child: VideoPlayer(videoController),
              ),
            )
          else if (isYoutubeVideo)
            // YouTube Player
            Center(
              child: YoutubePlayer(
                controller: youtubeController,
                showVideoProgressIndicator: true,
                progressIndicatorColor: Colors.red,
                progressColors: const ProgressBarColors(
                  playedColor: Colors.red,
                  handleColor: Colors.redAccent,
                ),
                onReady: () {
                  if (index == _currentIndex) {
                    youtubeController.play();
                  }
                },
              ),
            )
          else if (video['videoUrl'] != null &&
              !video['videoUrl'].toString().toLowerCase().contains(
                'youtube.com',
              ) &&
              !video['videoUrl'].toString().toLowerCase().contains('youtu.be'))
            // External URL that is NOT YouTube - show placeholder with link (fallback)
            Container(
              color: Colors.black,
              child: Center(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      Icons.play_circle_outline,
                      size: 80,
                      color: Colors.white,
                    ),
                    SizedBox(height: 16),
                    Text(
                      'External Video',
                      style: TextStyle(color: Colors.white, fontSize: 18),
                    ),
                    SizedBox(height: 8),
                    Text(
                      'This video cannot be played inline.',
                      style: TextStyle(color: Colors.white54, fontSize: 14),
                    ),
                  ],
                ),
              ),
            )
          else
            Container(
              color: Colors.black,
              child: Center(
                child: CircularProgressIndicator(color: Colors.white),
              ),
            ),

          // Play/Pause indicator (only for uploaded videos as Youtube has its own controls usually hidden or overlay)
          if (hasUploadedVideo &&
              videoController != null &&
              videoController.value.isInitialized)
            Center(
              child: AnimatedOpacity(
                opacity: videoController.value.isPlaying ? 0.0 : 1.0,
                duration: Duration(milliseconds: 200),
                child: Icon(Icons.play_arrow, size: 80, color: Colors.white),
              ),
            ),

          // Video Info Overlay
          Positioned(
            bottom: 0,
            left: 0,
            right: 80,
            child: Container(
              padding: EdgeInsets.all(16),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.bottomCenter,
                  end: Alignment.topCenter,
                  colors: [Colors.black.withOpacity(0.8), Colors.transparent],
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    video['title'] ?? '',
                    style: TextStyle(
                      color: Colors.white,
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  if (video['content'] != null && video['content'].isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 8.0),
                      child: Text(
                        video['content'],
                        style: TextStyle(color: Colors.white70, fontSize: 14),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  SizedBox(height: 8),
                  Row(
                    children: [
                      Icon(Icons.person, size: 16, color: Colors.white70),
                      SizedBox(width: 4),
                      Text(
                        video['author'] ?? 'Unknown',
                        style: TextStyle(color: Colors.white70, fontSize: 12),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),

          // Action Buttons (Right Side)
          Positioned(
            right: 8,
            bottom: 100,
            child: Column(
              children: [
                _buildActionButton(
                  icon: Icons.favorite_border,
                  label: '${video['likes'] ?? 0}',
                  onTap: () {
                    // Handle like
                  },
                ),
                SizedBox(height: 20),
                _buildActionButton(
                  icon: Icons.comment,
                  label: '${video['comments'] ?? 0}',
                  onTap: () {
                    // Handle comment
                  },
                ),
                SizedBox(height: 20),
                _buildActionButton(
                  icon: Icons.share,
                  label: 'Share',
                  onTap: () {
                    // Handle share
                  },
                ),
              ],
            ),
          ),

          // Close button
          Positioned(
            top: MediaQuery.of(context).padding.top + 8,
            left: 8,
            child: IconButton(
              icon: Icon(Icons.close, color: Colors.white),
              onPressed: () => Navigator.pop(context),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildActionButton({
    required IconData icon,
    required String label,
    required VoidCallback onTap,
  }) {
    return GestureDetector(
      onTap: onTap,
      child: Column(
        children: [
          Container(
            padding: EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.white.withOpacity(0.2),
              shape: BoxShape.circle,
            ),
            child: Icon(icon, color: Colors.white, size: 28),
          ),
          SizedBox(height: 4),
          Text(
            label,
            style: TextStyle(
              color: Colors.white,
              fontSize: 12,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }
}
