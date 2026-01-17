import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:short_neww_app/models/ad_model.dart';
import 'package:short_neww_app/widgets/ad_image_carousel.dart';

void main() {
  group('Debug Ad Carousel', () {
    testWidgets('Check carousel behavior with multiple images', (WidgetTester tester) async {
      // Create an ad model with multiple images
      final adWithMultipleImages = AdModel(
        id: 'test_ad_1',
        title: 'Test Ad',
        imageUrl: '/test/image1.jpg',
        imageUrls: [
          '/test/image1.jpg',
          '/test/image2.jpg',
          '/test/image3.jpg'
        ],
        positionInterval: 3,
        createdAt: DateTime.now(),
      );
      
      print('Ad imageUrls length: ${adWithMultipleImages.imageUrls.length}');
      print('Ad imageUrls: ${adWithMultipleImages.imageUrls}');
      
      // Build the AdImageCarousel widget
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AdImageCarousel(
              imageUrls: adWithMultipleImages.imageUrls,
              height: 200,
              width: 300,
            ),
          ),
        ),
      );
      
      // Check if PageView is displayed (indicates multiple images)
      final pageViewFinder = find.byType(PageView);
      print('PageView found: ${pageViewFinder.evaluate().length}');
      
      if (pageViewFinder.evaluate().isNotEmpty) {
        print('Multiple images detected - Carousel should be active');
      } else {
        print('Single image mode - No carousel');
      }
      
      // Check for page indicators
      final indicatorFinder = find.byWidgetPredicate((widget) {
        return widget is Container && 
               widget.decoration != null && 
               widget.decoration is BoxDecoration &&
               (widget.decoration as BoxDecoration).shape == BoxShape.circle;
      });
      
      print('Page indicators found: ${indicatorFinder.evaluate().length}');
      
      expect(adWithMultipleImages.imageUrls.length, 3);
    });
    
    testWidgets('Check carousel behavior with single image', (WidgetTester tester) async {
      // Create an ad model with single image
      final adWithSingleImage = AdModel(
        id: 'test_ad_2',
        title: 'Test Ad',
        imageUrl: '/test/image1.jpg',
        imageUrls: [
          '/test/image1.jpg'
        ],
        positionInterval: 5,
        createdAt: DateTime.now(),
      );
      
      print('Ad imageUrls length: ${adWithSingleImage.imageUrls.length}');
      print('Ad imageUrls: ${adWithSingleImage.imageUrls}');
      
      // Build the AdImageCarousel widget
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AdImageCarousel(
              imageUrls: adWithSingleImage.imageUrls,
              height: 200,
              width: 300,
            ),
          ),
        ),
      );
      
      // Check if PageView is displayed (indicates multiple images)
      final pageViewFinder = find.byType(PageView);
      print('PageView found: ${pageViewFinder.evaluate().length}');
      
      if (pageViewFinder.evaluate().isNotEmpty) {
        print('Multiple images detected - Carousel should be active');
      } else {
        print('Single image mode - No carousel');
      }
      
      expect(adWithSingleImage.imageUrls.length, 1);
    });
  });
}