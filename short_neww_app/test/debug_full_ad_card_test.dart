import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:short_neww_app/models/ad_model.dart';
import 'package:short_neww_app/widgets/ad_card.dart';

void main() {
  group('Debug Full Ad Card', () {
    testWidgets('Check AdCard with multiple images', (WidgetTester tester) async {
      // Create an ad model with multiple images like in the examples
      final adWithMultipleImages = AdModel(
        id: '68fba12e06f2ad37d3239538',
        title: 'Test Ad with Multiple Images',
        content: '',
        imageUrl: '/uploads/media-1761321248334-352248144.jpg',
        imageUrls: [
          '/uploads/media-1761321248334-352248144.jpg',
          '/uploads/media-1761321248351-168885750.jpg',
          '/uploads/media-1761321248373-549821972.jpg'
        ],
        linkUrl: '',
        positionInterval: 3,
        createdAt: DateTime.parse('2025-10-24T15:54:22.586Z'),
      );
      
      print('Testing AdCard with multiple images:');
      print('Ad imageUrls length: ${adWithMultipleImages.imageUrls.length}');
      print('Ad imageUrls: ${adWithMultipleImages.imageUrls}');
      
      // Build the AdCard widget with specific constraints
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              height: 400,
              width: 300,
              child: AdCard(
                ad: adWithMultipleImages,
              ),
            ),
          ),
        ),
      );
      
      // Check if we can find the AdImageCarousel
      final adImageCarouselFinder = find.byType(AdCard);
      print('AdCard widgets found: ${adImageCarouselFinder.evaluate().length}');
      
      // Look for PageView specifically
      final pageViewFinder = find.byType(PageView);
      print('PageView widgets found: ${pageViewFinder.evaluate().length}');
      
      if (pageViewFinder.evaluate().isNotEmpty) {
        print('SUCCESS: Multiple images are displayed in a carousel');
      } else {
        print('ISSUE: Multiple images are NOT displayed in a carousel');
      }
      
      expect(adWithMultipleImages.imageUrls.length, 3);
    });
    
    testWidgets('Check AdCard with single image', (WidgetTester tester) async {
      // Create an ad model with single image like in the examples
      final adWithSingleImage = AdModel(
        id: '68fc67b3b355c0b3a98adf79',
        title: 'Test Ad with Single Image',
        content: '',
        imageUrl: '/uploads/media-1761372078718-325466223.jpg',
        imageUrls: [
          '/uploads/media-1761372078718-325466223.jpg'
        ],
        linkUrl: '',
        positionInterval: 5,
        createdAt: DateTime.parse('2025-10-25T06:01:23.487Z'),
      );
      
      print('Testing AdCard with single image:');
      print('Ad imageUrls length: ${adWithSingleImage.imageUrls.length}');
      print('Ad imageUrls: ${adWithSingleImage.imageUrls}');
      
      // Build the AdCard widget with specific constraints
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              height: 400,
              width: 300,
              child: AdCard(
                ad: adWithSingleImage,
              ),
            ),
          ),
        ),
      );
      
      // Check if we can find the AdImageCarousel
      final adImageCarouselFinder = find.byType(AdCard);
      print('AdCard widgets found: ${adImageCarouselFinder.evaluate().length}');
      
      // Look for PageView specifically
      final pageViewFinder = find.byType(PageView);
      print('PageView widgets found: ${pageViewFinder.evaluate().length}');
      
      if (pageViewFinder.evaluate().isEmpty) {
        print('SUCCESS: Single image is displayed directly (no carousel)');
      } else {
        print('ISSUE: Single image is displayed in a carousel');
      }
      
      expect(adWithSingleImage.imageUrls.length, 1);
    });
  });
}