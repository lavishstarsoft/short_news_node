import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:short_neww_app/widgets/ad_image_carousel.dart';

void main() {
  group('AdImageCarousel', () {
    testWidgets('Should display single image correctly', (WidgetTester tester) async {
      final imageUrls = ['/test/image1.jpg'];
      
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
      
      // Should display one CachedNetworkImage
      expect(find.byType(PageView), findsNothing);
      // The single image is displayed directly, not in a PageView
    });
    
    testWidgets('Should display multiple images in carousel', (WidgetTester tester) async {
      final imageUrls = [
        '/test/image1.jpg',
        '/test/image2.jpg',
        '/test/image3.jpg'
      ];
      
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
      
      // Should display PageView for multiple images
      expect(find.byType(PageView), findsOneWidget);
      
      // Should display page indicators
      expect(find.byType(Container), findsWidgets);
    });
  });
}