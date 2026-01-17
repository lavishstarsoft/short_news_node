import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';
import 'package:flutter/services.dart';
import '../models/news_model.dart';
import '../services/news_api_service.dart';

class FullscreenVideoPlayer extends StatefulWidget {
  final NewsModel news;
  final VideoPlayerController? videoController;

  const FullscreenVideoPlayer({
    super.key,
    required this.news,
    this.videoController,
  });

  @override
  State<FullscreenVideoPlayer> createState() => _FullscreenVideoPlayerState();
}

class _FullscreenVideoPlayerState extends State<FullscreenVideoPlayer> {
  VideoPlayerController? _videoController;
  bool _isPlaying = false;
  bool _showControls = true;
  double _volume = 1.0;
  bool _disposed = false;
  bool _initialized = false;

  @override
  void initState() {
    super.initState();
    // Set status bar icons to white for fullscreen video
    SystemChrome.setSystemUIOverlayStyle(
      SystemUiOverlayStyle.light.copyWith(
        statusBarColor: Colors.transparent,
      ),
    );
    _initializeVideo();
  }

  @override
  void dispose() {
    _disposed = true;
    // Only dispose the controller if we created it (not passed from outside)
    if (widget.videoController == null && _videoController != null) {
      _videoController!.dispose();
    }
    super.dispose();
  }

  void _initializeVideo() async {
    try {
      // If a controller was passed, use it
      if (widget.videoController != null) {
        _videoController = widget.videoController;
      } else {
        // Create a new controller using mediaUrl if available, otherwise fallback to imageUrl
        String videoSource = widget.news.mediaUrl ?? widget.news.imageUrl;
        final videoUrl = NewsApiService.getFullImageUrl(videoSource);
        _videoController = VideoPlayerController.networkUrl(Uri.parse(videoUrl));
        await _videoController!.initialize();
      }

      // Add listener for state changes
      _videoController!.addListener(_videoListener);

      // Start playing if not already playing
      if (!_videoController!.value.isPlaying) {
        await _videoController!.play();
      }

      if (_disposed) return;

      // Use addPostFrameCallback to avoid calling setState during build
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!_disposed && mounted) {
          setState(() {
            _initialized = true;
            _isPlaying = _videoController!.value.isPlaying;
            _volume = _videoController!.value.volume;
          });

          // Auto-hide controls after 3 seconds
          Future.delayed(Duration(seconds: 3), () {
            if (!_disposed && mounted && _showControls) {
              setState(() {
                _showControls = false;
              });
            }
          });
        }
      });
    } catch (e) {
      print('Error initializing fullscreen video: $e');
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!_disposed && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Failed to load video: $e')),
          );
          Navigator.pop(context);
        }
      });
    }
  }

  void _videoListener() {
    if (_disposed) return;
    // Use addPostFrameCallback to avoid calling setState during build
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_disposed && mounted) {
        setState(() {
          _isPlaying = _videoController!.value.isPlaying;
          _volume = _videoController!.value.volume;
        });
      }
    });
  }

  void _togglePlayPause() {
    if (_videoController == null) return;

    setState(() {
      _showControls = true;
    });

    if (_isPlaying) {
      _videoController!.pause();
    } else {
      _videoController!.play();
    }

    // Auto-hide controls after 3 seconds
    Future.delayed(Duration(seconds: 3), () {
      if (!_disposed && mounted && _showControls) {
        setState(() {
          _showControls = false;
        });
      }
    });
  }

  void _toggleVolume() {
    if (_videoController == null) return;

    setState(() {
      _showControls = true;
    });

    if (_volume == 0) {
      _videoController!.setVolume(1.0);
      setState(() {
        _volume = 1.0;
      });
    } else {
      _videoController!.setVolume(0.0);
      setState(() {
        _volume = 0.0;
      });
    }

    // Auto-hide controls after 3 seconds
    Future.delayed(Duration(seconds: 3), () {
      if (!_disposed && mounted && _showControls) {
        setState(() {
          _showControls = false;
        });
      }
    });
  }

  void _seekVideo(double value) {
    if (_videoController == null) return;

    final duration = Duration(milliseconds: value.toInt());
    _videoController!.seekTo(duration);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(
        child: GestureDetector(
          onTap: () {
            setState(() {
              _showControls = !_showControls;
            });

            // Auto-hide controls after 3 seconds
            if (_showControls) {
              Future.delayed(Duration(seconds: 3), () {
                if (!_disposed && mounted && _showControls) {
                  setState(() {
                    _showControls = false;
                  });
                }
              });
            }
          },
          child: Stack(
            children: [
              // Video player
              Center(
                child: _videoController != null && _initialized
                    ? AspectRatio(
                        aspectRatio: _videoController!.value.aspectRatio,
                        child: VideoPlayer(_videoController!),
                      )
                    : Center(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            CircularProgressIndicator(
                              valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                            ),
                            SizedBox(height: 16),
                            Text(
                              'Loading video...',
                              style: TextStyle(color: Colors.white),
                            ),
                          ],
                        ),
                      ),
              ),

              // Controls overlay
              if (_showControls && _videoController != null && _initialized)
                Positioned.fill(
                  child: Container(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [
                          Colors.black.withValues(alpha: 0.7),
                          Colors.transparent,
                          Colors.transparent,
                          Colors.black.withValues(alpha: 0.7),
                        ],
                        stops: [0.0, 0.3, 0.7, 1.0],
                      ),
                    ),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        // Top bar with back button
                        Padding(
                          padding: EdgeInsets.all(16),
                          child: Row(
                            children: [
                              GestureDetector(
                                onTap: () {
                                  if (mounted) {
                                    Navigator.pop(context);
                                  }
                                },
                                child: Container(
                                  padding: EdgeInsets.all(8),
                                  decoration: BoxDecoration(
                                    color: Colors.black.withValues(alpha: 0.5),
                                    shape: BoxShape.circle,
                                  ),
                                  child: Icon(
                                    Icons.close,
                                    color: Colors.white,
                                    size: 24,
                                  ),
                                ),
                              ),
                              Spacer(),
                              // Video title
                              Expanded(
                                child: Text(
                                  widget.news.title,
                                  style: TextStyle(
                                    color: Colors.white,
                                    fontSize: 16,
                                    fontWeight: FontWeight.bold,
                                  ),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  textAlign: TextAlign.center,
                                ),
                              ),
                              Spacer(),
                              // Placeholder for balance
                              Container(
                                width: 40,
                              ),
                            ],
                          ),
                        ),

                        // Bottom controls
                        Padding(
                          padding: EdgeInsets.all(16),
                          child: Column(
                            children: [
                              // Progress bar
                              if (_videoController!.value.isInitialized)
                                SliderTheme(
                                  data: SliderTheme.of(context).copyWith(
                                    activeTrackColor: Colors.red,
                                    inactiveTrackColor: Colors.white38,
                                    thumbColor: Colors.red,
                                    thumbShape: RoundSliderThumbShape(enabledThumbRadius: 6),
                                    overlayShape: RoundSliderOverlayShape(overlayRadius: 12),
                                  ),
                                  child: Slider(
                                    value: _videoController!.value.position.inMilliseconds.toDouble(),
                                    min: 0.0,
                                    max: _videoController!.value.duration.inMilliseconds.toDouble(),
                                    onChanged: _seekVideo,
                                  ),
                                ),

                              // Time and controls row
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  // Current time
                                  Text(
                                    _formatDuration(_videoController!.value.position),
                                    style: TextStyle(color: Colors.white, fontSize: 12),
                                  ),
                                  // Controls
                                  Row(
                                    children: [
                                      // Volume button
                                      GestureDetector(
                                        onTap: _toggleVolume,
                                        child: Container(
                                          padding: EdgeInsets.all(8),
                                          decoration: BoxDecoration(
                                            color: Colors.black.withValues(alpha: 0.5),
                                            shape: BoxShape.circle,
                                          ),
                                          child: Icon(
                                            _volume == 0 ? Icons.volume_off : Icons.volume_up,
                                            color: Colors.white,
                                            size: 20,
                                          ),
                                        ),
                                      ),
                                      SizedBox(width: 16),
                                      // Play/Pause button
                                      GestureDetector(
                                        onTap: _togglePlayPause,
                                        child: Container(
                                          padding: EdgeInsets.all(12),
                                          decoration: BoxDecoration(
                                            color: Colors.black.withValues(alpha: 0.5),
                                            shape: BoxShape.circle,
                                          ),
                                          child: Icon(
                                            _isPlaying ? Icons.pause : Icons.play_arrow,
                                            color: Colors.white,
                                            size: 24,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                  // Total duration
                                  Text(
                                    _formatDuration(_videoController!.value.duration),
                                    style: TextStyle(color: Colors.white, fontSize: 12),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),

              // Center play/pause button
              if (_videoController != null && 
                  _initialized && 
                  _showControls)
                Center(
                  child: GestureDetector(
                    onTap: _togglePlayPause,
                    child: Container(
                      padding: EdgeInsets.all(16),
                      decoration: BoxDecoration(
                        color: Colors.black.withValues(alpha: 0.5),
                        shape: BoxShape.circle,
                      ),
                      child: Icon(
                        _isPlaying ? Icons.pause : Icons.play_arrow,
                        color: Colors.white,
                        size: 48,
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
}