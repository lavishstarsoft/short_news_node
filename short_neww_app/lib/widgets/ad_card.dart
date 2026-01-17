import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/ad_model.dart';
import '../services/user_preference_service.dart';
import '../services/intelligent_ad_service.dart'; // Updated import
import 'ad_image_carousel.dart';

class AdCard extends StatefulWidget {
  final AdModel ad;
  final VoidCallback? onTap;

  const AdCard({super.key, required this.ad, this.onTap});

  @override
  State<AdCard> createState() => _AdCardState();
}

class _AdCardState extends State<AdCard> {
  DateTime? viewStartTime;

  @override
  void initState() {
    super.initState();
    // Record when the ad is first viewed
    viewStartTime = DateTime.now();
  }

  @override
  void dispose() {
    // Calculate view duration when the widget is disposed
    if (viewStartTime != null) {
      final viewDuration = DateTime.now().difference(viewStartTime!);
      // Record ad view interaction with duration using intelligent ad service
      _recordAdInteraction('view', viewDuration.inSeconds);
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        print(
          'AdCard constraints: maxWidth = ${constraints.maxWidth}, maxHeight = ${constraints.maxHeight}',
        );

        // Ensure we have valid dimensions
        final effectiveHeight =
            constraints.maxHeight != double.infinity
                ? constraints.maxHeight
                : 200.0;
        final effectiveWidth =
            constraints.maxWidth != double.infinity
                ? constraints.maxWidth
                : double.infinity;

        print(
          'AdCard effective dimensions: width = $effectiveWidth, height = $effectiveHeight',
        );

        return GestureDetector(
          onTap: () {
            if (widget.ad.linkUrl != null && widget.ad.linkUrl!.isNotEmpty) {
              _launchURL(widget.ad.linkUrl!);
            }
            // Record ad click interaction using intelligent ad service
            _recordAdInteraction('click');
            // Mark ad as seen
            UserPreferenceService.markAdAsSeen(widget.ad.id);
            widget.onTap?.call();
          },
          child: Container(
            width: effectiveWidth,
            height: effectiveHeight,
            // Removed margin and box decoration as requested
            child: ClipRRect(
              borderRadius: BorderRadius.circular(12.0),
              child: Stack(
                fit: StackFit.expand,
                children: [
                  // Background to prevent transparent areas
                  Container(color: Colors.grey[900]),
                  // Ad image carousel with multiple images support
                  AdImageCarousel(
                    imageUrls:
                        widget.ad.imageUrls.isNotEmpty ? widget.ad.imageUrls : [widget.ad.imageUrl],
                    height: effectiveHeight,
                    width:
                        effectiveWidth != double.infinity
                            ? effectiveWidth
                            : null,
                    fit: BoxFit.cover,
                    showIndicator: widget.ad.imageUrls.length > 1,
                    showNavigationButtons: widget.ad.imageUrls.length > 1,
                  ),
                  // Removed gradient overlay as requested
                  // Ad information overlay - removed title and content as requested
                  // Ad badge - kept this as it's important for identifying ads
                  if (widget.ad.linkUrl != null && widget.ad.linkUrl!.isNotEmpty)
                    Positioned(
                      top: 12,
                      right: 12,
                      child: Container(
                        padding: EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 4,
                        ),
                        decoration: BoxDecoration(
                          color: Colors.blue,
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Text(
                          'Ad',
                          style: TextStyle(
                            color: Colors.white,
                            fontSize: 12,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  void _launchURL(String url) async {
    try {
      final uri = Uri.parse(url);
      if (await canLaunchUrl(uri)) {
        await launchUrl(uri);
      } else {
        print('Could not launch $url');
      }
    } catch (e) {
      print('Error launching URL: $e');
    }
  }
  
  // Record ad interaction (view or click) with the backend using intelligent ad service
  void _recordAdInteraction(String interactionType, [int? viewDurationSeconds]) async {
    try {
      // Record analytics using intelligent ad service
      await IntelligentAdService.recordAdAnalytics(
        adId: widget.ad.id,
        adTitle: widget.ad.title,
        interactionType: interactionType,
        viewDurationSeconds: viewDurationSeconds,
      );
    } catch (e) {
      print('Error recording ad interaction: $e');
    }
  }
}