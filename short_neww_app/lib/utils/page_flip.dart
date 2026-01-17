import 'dart:math';
import 'package:flutter/material.dart';

/// A widget that provides a book-like page turn animation
/// between pages as the user swipes vertically
class PageFlipWidget extends StatefulWidget {
  final List<Widget> pages;
  final Duration duration;
  final Color shadowColor;
  final double elevation;
  final Curve curve;
  final VoidCallback? onPageChanged;
  final int initialPage;
  final bool dragEnabled;
  final PageFlipController? controller; // Add controller parameter

  const PageFlipWidget({
    Key? key,
    required this.pages,
    this.duration = const Duration(milliseconds: 600),
    this.shadowColor = Colors.black54,
    this.elevation = 8.0,
    this.curve = Curves.easeOutCubic,
    this.onPageChanged,
    this.initialPage = 0,
    this.dragEnabled = true,
    this.controller, // Add controller to constructor
  }) : super(key: key);

  @override
  PageFlipWidgetState createState() => PageFlipWidgetState();
}

class PageFlipWidgetState extends State<PageFlipWidget>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _animation;
  int _currentPage = 0;
  int _nextPage = 0;
  bool _isForward = true;
  double _dragPosition = 0.0;
  bool _isDragging = false;
  late PageController _pageController;

  @override
  void initState() {
    super.initState();
    _currentPage = widget.initialPage;
    _controller = AnimationController(vsync: this, duration: widget.duration);
    _animation = Tween<double>(
      begin: 0.0,
      end: 1.0,
    ).animate(CurvedAnimation(parent: _controller, curve: widget.curve));
    _animation.addListener(() {
      setState(() {});
    });
    _animation.addStatusListener((status) {
      if (status == AnimationStatus.completed) {
        setState(() {
          _currentPage = _nextPage;
          _controller.reset();
          _isDragging = false;
        });
        if (widget.onPageChanged != null) {
          widget.onPageChanged!();
        }
      }
    });
    _pageController = PageController(initialPage: _currentPage);
    
    // Attach controller if provided
    widget.controller?._attach(this);
  }

  @override
  void dispose() {
    _controller.dispose();
    _pageController.dispose();
    super.dispose();
  }

  void nextPage() {
    if (_currentPage < widget.pages.length - 1) {
      _isForward = true;
      _nextPage = _currentPage + 1;
      _controller.forward();
    }
  }

  void previousPage() {
    if (_currentPage > 0) {
      _isForward = false;
      _nextPage = _currentPage - 1;
      _controller.forward();
    }
  }

  void jumpToPage(int page) {
    if (page >= 0 && page < widget.pages.length && page != _currentPage) {
      _isForward = page > _currentPage;
      _nextPage = page;
      _controller.forward();
    }
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onVerticalDragStart: widget.dragEnabled ? _handleDragStart : null,
      onVerticalDragUpdate: widget.dragEnabled ? _handleDragUpdate : null,
      onVerticalDragEnd: widget.dragEnabled ? _handleDragEnd : null,
      child: Stack(
        children: [
          // Current page
          _buildPage(_currentPage),

          // Next page with clip path for animation
          if (_controller.isAnimating || _isDragging) _buildFlippingPage(),
        ],
      ),
    );
  }

  void _handleDragStart(DragStartDetails details) {
    _isDragging = true;
    _dragPosition = 0;
  }

  void _handleDragUpdate(DragUpdateDetails details) {
    setState(() {
      _dragPosition += details.delta.dy;
      // Determine if going to next or previous page
      if (_dragPosition > 0) {
        // Dragging downward (to next page)
        _isForward = true;
        _nextPage =
            _currentPage + 1 < widget.pages.length
                ? _currentPage + 1
                : _currentPage;
      } else {
        // Dragging upward (to previous page)
        _isForward = false;
        _nextPage = _currentPage - 1 >= 0 ? _currentPage - 1 : _currentPage;
      }
    });
  }

  void _handleDragEnd(DragEndDetails details) {
    final velocity = details.velocity.pixelsPerSecond.dy;
    final dragDistance = _dragPosition.abs();

    if (_nextPage != _currentPage &&
        (dragDistance > 100 || velocity.abs() > 800)) {
      // Complete the animation
      _controller.forward();
    } else {
      // Cancel the animation
      setState(() {
        _isDragging = false;
      });
    }
    _dragPosition = 0;
  }

  Widget _buildPage(int index) {
    if (index < 0 || index >= widget.pages.length) {
      return const SizedBox.shrink();
    }

    return Container(
      key: ValueKey('page_$index'),
      decoration: BoxDecoration(
        color: Theme.of(context).scaffoldBackgroundColor,
        boxShadow: [
          BoxShadow(
            color: widget.shadowColor.withOpacity(0.3),
            blurRadius: 5.0,
            spreadRadius: 1.0,
          ),
        ],
      ),
      child: widget.pages[index],
    );
  }

  Widget _buildFlippingPage() {
    final progress =
        _isDragging
            ? (_dragPosition.abs() / MediaQuery.of(context).size.height).clamp(
              0.0,
              0.5,
            )
            : _animation.value;

    final size = MediaQuery.of(context).size;
    final height = size.height;
    final width = size.width;

    // Determine which page is visible during flip
    final visiblePageIndex = _isForward ? _nextPage : _currentPage;
    final hiddenPageIndex = _isForward ? _currentPage : _nextPage;

    if (visiblePageIndex < 0 ||
        visiblePageIndex >= widget.pages.length ||
        hiddenPageIndex < 0 ||
        hiddenPageIndex >= widget.pages.length) {
      return const SizedBox.shrink();
    }

    // Calculate rotation angle based on progress
    final angle = _isForward ? -progress * pi : (progress - 1) * pi;

    // Calculate fold position
    final foldPosition =
        _isForward ? height * (1 - progress) : height * progress;

    return Stack(
      children: [
        // The static page beneath
        _buildPage(_isForward ? _nextPage : _currentPage),

        // Top half - stays in place
        ClipRect(
          child: Align(
            alignment: Alignment.topCenter,
            heightFactor: 0.5,
            child: _buildPage(hiddenPageIndex),
          ),
        ),

        // Bottom half - flips
        Transform(
          alignment: Alignment.topCenter,
          transform:
              Matrix4.identity()
                ..setEntry(3, 2, 0.001) // Perspective
                ..rotateX(angle),
          child: ClipRect(
            child: Align(
              alignment: Alignment.bottomCenter,
              heightFactor: 0.5,
              child: _buildPage(
                progress > 0.5 ? visiblePageIndex : hiddenPageIndex,
              ),
            ),
          ),
        ),

        // Shadow that follows the fold
        Positioned(
          top: foldPosition - 10,
          left: 0,
          right: 0,
          height: 20,
          child: Opacity(
            opacity: progress < 0.5 ? progress * 2 : (1 - progress) * 2,
            child: Container(
              decoration: BoxDecoration(
                boxShadow: [
                  BoxShadow(
                    color: widget.shadowColor,
                    blurRadius: widget.elevation,
                    spreadRadius: widget.elevation / 2,
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// Extension for PageFlipController to control the page flip widget externally
class PageFlipController {
  PageFlipWidgetState? _state;

  // Add a default constructor
  PageFlipController();

  void _attach(PageFlipWidgetState state) {
    _state = state;
  }

  void nextPage() {
    _state?.nextPage();
  }

  void previousPage() {
    _state?.previousPage();
  }

  void jumpToPage(int page) {
    _state?.jumpToPage(page);
  }

  int get currentPage => _state?._currentPage ?? 0;
}