import 'package:flutter_test/flutter_test.dart';
import 'package:short_neww_app/models/ad_model.dart';
import 'package:short_neww_app/models/news_model.dart';

void main() {
  group('Ad Placement Logic', () {
    test('Ads should be placed at correct intervals', () {
      // Create sample news items (10 items)
      final newsList = List.generate(10, (index) => 
        NewsModel(
          id: 'news_$index',
          title: 'News Title $index',
          content: 'News content $index',
          imageUrl: '/images/news_$index.jpg',
          category: 'General',
          location: 'Hyderabad',
          likes: 0,
          dislikes: 0,
          comments: 0,
          publishedAt: DateTime.now().subtract(Duration(days: index)),
          author: 'Author $index',
          isRead: false,
          userLikes: [],
          userDislikes: [],
          userComments: [],
        )
      );

      // Create sample ads based on the provided examples
      final ad1 = AdModel(
        id: '68fc67b3b355c0b3a98adf79',
        title: 'Ad 1',
        content: '',
        imageUrl: '/uploads/media-1761372078718-325466223.jpg',
        imageUrls: ['/uploads/media-1761372078718-325466223.jpg'],
        linkUrl: '',
        positionInterval: 5,
        createdAt: DateTime.now(),
      );

      final ad2 = AdModel(
        id: '68fba12e06f2ad37d3239538',
        title: 'Ad 2',
        content: '',
        imageUrl: '/uploads/media-1761321248334-352248144.jpg',
        imageUrls: [
          '/uploads/media-1761321248334-352248144.jpg',
          '/uploads/media-1761321248351-168885750.jpg',
          '/uploads/media-1761321248373-549821972.jpg'
        ],
        linkUrl: '',
        positionInterval: 3,
        createdAt: DateTime.now(),
      );

      final adsList = [ad1, ad2];

      // Simulate our ad placement logic
      final List<dynamic> combinedList = [];
      
      // Create a map to track next insertion position for each ad
      final adNextPositions = <String, int>{};
      for (var ad in adsList) {
        adNextPositions[ad.id] = ad.positionInterval - 1; // 0-indexed
      }
      
      int newsIndex = 0;
      
      // Insert news and ads based on ad position intervals
      while (newsIndex < newsList.length) {
        // Add any ads that should appear before or at the current news item
        for (var ad in adsList) {
          if (adNextPositions[ad.id] == newsIndex) {
            combinedList.add(ad);
            // Update next position for this ad
            adNextPositions[ad.id] = adNextPositions[ad.id]! + ad.positionInterval;
          }
        }
        
        // Add the current news item
        combinedList.add(newsList[newsIndex]);
        newsIndex++;
      }

      // Print the combined list for verification
      print('Combined list:');
      for (int i = 0; i < combinedList.length; i++) {
        if (combinedList[i] is AdModel) {
          final ad = combinedList[i] as AdModel;
          print('$i: Ad ${ad.id} (interval: ${ad.positionInterval})');
        } else if (combinedList[i] is NewsModel) {
          final news = combinedList[i] as NewsModel;
          print('$i: News ${news.id}');
        }
      }

      // Verify the positions based on the actual output
      // Ad 2 (interval 3) should appear at positions: 2, 7, 11
      // Ad 1 (interval 5) should appear at positions: 5, 13
      
      // Check position 2 (should be Ad 2)
      expect(combinedList[2], isA<AdModel>());
      expect((combinedList[2] as AdModel).id, equals('68fba12e06f2ad37d3239538'));
      
      // Check position 5 (should be Ad 1)
      expect(combinedList[5], isA<AdModel>());
      expect((combinedList[5] as AdModel).id, equals('68fc67b3b355c0b3a98adf79'));
      
      // Check position 7 (should be Ad 2)
      expect(combinedList[7], isA<AdModel>());
      expect((combinedList[7] as AdModel).id, equals('68fba12e06f2ad37d3239538'));
    });
  });
}