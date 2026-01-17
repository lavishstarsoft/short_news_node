import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../services/news_api_service.dart';

/// A carousel widget to display multiple ad images with manual navigation
class AdImageCarousel extends StatefulWidget {
  final List<String> imageUrls;
  final double? height;
  final double? width;
  final BoxFit fit;
  final VoidCallback? onPageChanged;
  final bool showIndicator;
  final bool showNavigationButtons;

  const AdImageCarousel({
    super.key,
    required this.imageUrls,
    this.height,
    this.width,
    this.fit = BoxFit.cover,
    this.onPageChanged,
    this.showIndicator = true,
    this.showNavigationButtons = true,
  });

  @override
  State<AdImageCarousel> createState() => _AdImageCarouselState();
}

class _AdImageCarouselState extends State<AdImageCarousel> {
  late PageController _pageController;
  int _currentPage = 0;

  @override
  void initState() {
    super.initState();
    _pageController = PageController();
    // Preload next image
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _preloadImages();
    });
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  /// Preload images for smoother transitions
  void _preloadImages() {
    if (widget.imageUrls.length <= 1) return;

    // Preload next image
    final nextIndex = (_currentPage + 1) % widget.imageUrls.length;
    if (nextIndex < widget.imageUrls.length) {
      final nextImageUrl = widget.imageUrls[nextIndex];
      precacheImage(
        CachedNetworkImageProvider(
          NewsApiService.getFullImageUrl(nextImageUrl),
        ),
        context,
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.imageUrls.isEmpty) {
      return Container();
    }

    // For single image display
    if (widget.imageUrls.length == 1) {
      return _buildSingleImage();
    }

    // For multiple images, display carousel
    return _buildCarousel();
  }

  Widget _buildSingleImage() {
    return CachedNetworkImage(
      imageUrl: NewsApiService.getFullImageUrl(widget.imageUrls.first),
      height: widget.height,
      width: widget.width,
      fit: widget.fit,
      placeholder: (context, url) => _buildPlaceholder(),
      errorWidget: (context, url, error) => _buildErrorWidget(),
    );
  }

  Widget _buildCarousel() {
    return SizedBox(
      height: widget.height,
      width: widget.width,
      child: Stack(
        children: [
          // PageView for swiping images
          PageView.builder(
            controller: _pageController,
            itemCount: widget.imageUrls.length,
            onPageChanged: (index) {
              setState(() {
                _currentPage = index;
              });
              _preloadImages();
              if (widget.onPageChanged != null) {
                widget.onPageChanged!();
              }
            },
            itemBuilder: (context, index) {
              final imageUrl = widget.imageUrls[index];
              return CachedNetworkImage(
                imageUrl: NewsApiService.getFullImageUrl(imageUrl),
                fit: widget.fit,
                placeholder: (context, url) => _buildPlaceholder(),
                errorWidget: (context, url, error) => _buildErrorWidget(),
              );
            },
          ),

          // Page indicator dots
          if (widget.showIndicator) _buildPageIndicator(),

          // Navigation arrows
          if (widget.showNavigationButtons) _buildNavigationButtons(),
        ],
      ),
    );
  }

  Widget _buildPlaceholder() {
    return Container(
      height: widget.height,
      width: widget.width,
      color: Colors.grey[300],
      child: Center(
        child: CircularProgressIndicator(
          valueColor: AlwaysStoppedAnimation<Color>(Colors.grey[600]!),
        ),
      ),
    );
  }

  Widget _buildErrorWidget() {
    return Container(
      height: widget.height,
      width: widget.width,
      color: Colors.grey[800],
      child: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.error_outline, color: Colors.red, size: 48),
            const SizedBox(height: 10),
            const Text(
              'Failed to load image',
              style: TextStyle(color: Colors.white70),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildPageIndicator() {
    return Positioned(
      bottom: 10,
      left: 0,
      right: 0,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: List.generate(widget.imageUrls.length, (i) {
          return GestureDetector(
            onTap: () => _navigateToPage(i),
            child: Container(
              width: _currentPage == i ? 16 : 8,
              height: 8,
              margin: const EdgeInsets.symmetric(horizontal: 4),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(4),
                color:
                    _currentPage == i
                        ? Colors.white
                        : Colors.white.withOpacity(0.4),
                boxShadow:
                    _currentPage == i
                        ? [
                          BoxShadow(
                            color: Colors.black.withOpacity(0.3),
                            blurRadius: 2,
                            spreadRadius: 0,
                            offset: const Offset(0, 1),
                          ),
                        ]
                        : null,
              ),
            ),
          );
        }),
      ),
    );
  }

  Widget _buildNavigationButtons() {
    return Positioned.fill(
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          // Previous button
          GestureDetector(
            onTap: _navigateToPreviousPage,
            child: Container(
              margin: const EdgeInsets.only(left: 8),
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: Colors.black26,
                borderRadius: BorderRadius.circular(20),
              ),
              child: const Icon(
                Icons.arrow_back_ios_new,
                color: Colors.white,
                size: 20,
              ),
            ),
          ),

          // Next button
          GestureDetector(
            onTap: _navigateToNextPage,
            child: Container(
              margin: const EdgeInsets.only(right: 8),
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: Colors.black26,
                borderRadius: BorderRadius.circular(20),
              ),
              child: const Icon(
                Icons.arrow_forward_ios,
                color: Colors.white,
                size: 20,
              ),
            ),
          ),
        ],
      ),
    );
  }

  void _navigateToPage(int page) {
    _pageController.animateToPage(
      page,
      duration: const Duration(milliseconds: 300),
      curve: Curves.easeOutCubic,
    );
  }

  void _navigateToPreviousPage() {
    final previousPage =
        (_currentPage - 1 + widget.imageUrls.length) % widget.imageUrls.length;
    _navigateToPage(previousPage);
  }

  void _navigateToNextPage() {
    final nextPage = (_currentPage + 1) % widget.imageUrls.length;
    _navigateToPage(nextPage);
  }
}
