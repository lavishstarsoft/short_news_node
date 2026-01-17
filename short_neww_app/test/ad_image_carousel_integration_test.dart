import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:short_neww_app/widgets/ad_image_carousel.dart';
import 'package:cached_network_image/cached_network_image.dart';

void main() {
  group('AdImageCarousel Integration', () {
    testWidgets('Should display multiple images with horizontal swipe', (WidgetTester tester) async {
      // Test data with multiple images
      final imageUrls = [
        '/uploads/media-1761321248334-352248144.jpg',
        '/uploads/media-1761321248351-168885750.jpg',
        '/uploads/media-1761321248373-549821972.jpg'
      ];
      
      // Build the widget
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AdImageCarousel(
              imageUrls: imageUrls,
              height: 200,
              width: 300,
            ),
          ),
        ),
      );
      
      // Verify PageView is displayed for multiple images
      expect(find.byType(PageView), findsOneWidget);
      
      // Verify all images are displayed
      expect(find.byType(PageView), findsOneWidget);
      
      // Verify page indicators are displayed
      expect(find.byType(Container), findsWidgets);
      
      // Check that we have 3 page indicators (one for each image)
      final indicatorFinder = find.byWidgetPredicate((widget) {
        return widget is Container && 
               widget.decoration != null && 
               widget.decoration is BoxDecoration &&
               (widget.decoration as BoxDecoration).shape == BoxShape.circle;
      });
      
      expect(indicatorFinder, findsNWidgets(3));
    });
    
    testWidgets('Should display single image without carousel', (WidgetTester tester) async {
      // Test data with single image
      final imageUrls = [
        '/uploads/media-1761372078718-325466223.jpg'
      ];
      
      // Build the widget
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AdImageCarousel(
              imageUrls: imageUrls,
              height: 200,
              width: 300,
            ),
          ),
        ),
      );
      
      // Verify PageView is NOT displayed for single image
      expect(find.byType(PageView), findsNothing);
      
      // Verify CachedNetworkImage is displayed directly
      expect(find.byType(CachedNetworkImage), findsOneWidget);
    });
  });
}