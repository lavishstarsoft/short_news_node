import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:shimmer/shimmer.dart';

/// Helper utility for optimized image loading
class ImageHelper {
  /// Load a network image with caching and shimmer loading effect
  static Widget loadNetworkImage({
    required String imageUrl,
    double? width,
    double? height,
    BoxFit fit = BoxFit.cover,
    BorderRadius? borderRadius,
    bool withShimmer = true,
    Widget? errorWidget,
    Duration fadeInDuration = const Duration(milliseconds: 300),
  }) {
    // Create the shimmer placeholder
    final placeholder =
        withShimmer
            ? Shimmer.fromColors(
              baseColor: Colors.grey[300]!,
              highlightColor: Colors.grey[100]!,
              child: Container(
                width: width,
                height: height,
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: borderRadius,
                ),
              ),
            )
            : Container(width: width, height: height, color: Colors.grey[200]);

    // Create the error widget
    final defaultErrorWidget = Container(
      width: width,
      height: height,
      color: Colors.grey[200],
      child: const Center(child: Icon(Icons.error_outline, color: Colors.grey)),
    );

    // Create the image widget
    Widget imageWidget = CachedNetworkImage(
      imageUrl: imageUrl,
      width: width,
      height: height,
      fit: fit,
      fadeInDuration: fadeInDuration,
      placeholder: (context, url) => placeholder,
      errorWidget: (context, url, error) => errorWidget ?? defaultErrorWidget,
    );

    // Apply border radius if specified
    if (borderRadius != null) {
      imageWidget = ClipRRect(borderRadius: borderRadius, child: imageWidget);
    }

    return imageWidget;
  }

  /// Preload an image for future use
  static Future<void> preloadImage(
    BuildContext context,
    String imageUrl,
  ) async {
    try {
      await precacheImage(CachedNetworkImageProvider(imageUrl), context);
    } catch (e) {
      debugPrint('Error preloading image: $e');
    }
  }

  /// Calculate optimal memory cache dimensions based on device pixel ratio
  static (int?, int?) calculateOptimalCacheSize(
    BuildContext context,
    double? width,
    double? height,
  ) {
    if (width == null || height == null) return (null, null);

    final devicePixelRatio = MediaQuery.of(context).devicePixelRatio;
    final optimalWidth = (width * devicePixelRatio).ceil();
    final optimalHeight = (height * devicePixelRatio).ceil();

    return (optimalWidth, optimalHeight);
  }
}
