import 'package:flutter/material.dart';
import 'package:shimmer/shimmer.dart';

class ShimmerNewsCard extends StatelessWidget {
  const ShimmerNewsCard({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      height: double.infinity,
      color: Colors.black,
      child: Column(
        children: [
          // Realistic Image/Video Placeholder with shimmer
          Expanded(
            flex: 3,
            child: Stack(
              children: [
                // Background shimmer for image area
                Shimmer.fromColors(
                  baseColor: Colors.grey[900]!,
                  highlightColor: Colors.grey[800]!,
                  child: Container(
                    width: double.infinity,
                    height: double.infinity,
                    color: Colors.grey[900],
                  ),
                ),
                // Realistic image placeholder pattern
                Center(
                  child: Shimmer.fromColors(
                    baseColor: Colors.grey[800]!,
                    highlightColor: Colors.grey[700]!,
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(
                          Icons.image_outlined,
                          size: 80,
                          color: Colors.grey[700],
                        ),
                        SizedBox(height: 12),
                        Container(
                          height: 8,
                          width: 120,
                          decoration: BoxDecoration(
                            color: Colors.grey[700],
                            borderRadius: BorderRadius.circular(4),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),

          // Realistic Content Area with text line illusions
          Expanded(
            flex: 2,
            child: Container(
              width: double.infinity,
              padding: EdgeInsets.all(20),
              color: Colors.white,
              child: Shimmer.fromColors(
                baseColor: Colors.grey[300]!,
                highlightColor: Colors.grey[100]!,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Category badge placeholder
                    Container(
                      height: 20,
                      width: 80,
                      decoration: BoxDecoration(
                        color: Colors.grey[300],
                        borderRadius: BorderRadius.circular(10),
                      ),
                      margin: EdgeInsets.only(bottom: 12),
                    ),

                    // Title lines (looks like actual headline)
                    _buildTextLine(width: double.infinity, height: 22),
                    SizedBox(height: 8),
                    _buildTextLine(width: 280, height: 22),
                    SizedBox(height: 16),

                    // Content lines (looks like actual paragraph)
                    _buildTextLine(width: double.infinity, height: 14),
                    SizedBox(height: 6),
                    _buildTextLine(width: double.infinity, height: 14),
                    SizedBox(height: 6),
                    _buildTextLine(width: double.infinity, height: 14),
                    SizedBox(height: 6),
                    _buildTextLine(width: 220, height: 14),

                    Spacer(),

                    // Time and location placeholder
                    Row(
                      children: [
                        Container(
                          height: 12,
                          width: 60,
                          decoration: BoxDecoration(
                            color: Colors.grey[300],
                            borderRadius: BorderRadius.circular(6),
                          ),
                        ),
                        SizedBox(width: 12),
                        Container(
                          height: 12,
                          width: 80,
                          decoration: BoxDecoration(
                            color: Colors.grey[300],
                            borderRadius: BorderRadius.circular(6),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),

          // Bottom Interaction Bar with realistic button placeholders
          Container(
            padding: EdgeInsets.symmetric(horizontal: 20, vertical: 16),
            decoration: BoxDecoration(
              color: Colors.white,
              border: Border(
                top: BorderSide(color: Colors.grey[200]!, width: 1),
              ),
            ),
            child: Shimmer.fromColors(
              baseColor: Colors.grey[300]!,
              highlightColor: Colors.grey[100]!,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceAround,
                children: [
                  // Like button placeholder
                  _buildIconButtonPlaceholder(Icons.thumb_up_outlined),
                  // Dislike button placeholder
                  _buildIconButtonPlaceholder(Icons.thumb_down_outlined),
                  // Comment button placeholder
                  _buildIconButtonPlaceholder(Icons.comment_outlined),
                  // Share button placeholder
                  _buildIconButtonPlaceholder(Icons.share_outlined),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  // Helper to build realistic text line placeholders
  Widget _buildTextLine({required double width, required double height}) {
    return Container(
      height: height,
      width: width,
      decoration: BoxDecoration(
        color: Colors.grey[300],
        borderRadius: BorderRadius.circular(4),
      ),
    );
  }

  // Helper to build icon button placeholders
  Widget _buildIconButtonPlaceholder(IconData icon) {
    return Row(
      children: [
        Container(
          width: 24,
          height: 24,
          decoration: BoxDecoration(
            color: Colors.grey[300],
            shape: BoxShape.circle,
          ),
        ),
        SizedBox(width: 6),
        Container(
          height: 12,
          width: 30,
          decoration: BoxDecoration(
            color: Colors.grey[300],
            borderRadius: BorderRadius.circular(6),
          ),
        ),
      ],
    );
  }
}
