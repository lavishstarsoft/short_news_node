import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'package:short_neww_app/services/news_api_service.dart';

void main() {
  group('Debug Actual API Fetch', () {
    test('Fetch actual ads from API and check imageUrls', () async {
      try {
        // Fetch ads from the actual API
        final response = await http.get(
          Uri.parse('${NewsApiService.baseUrl}/api/public/ads'),
          headers: {
            'Content-Type': 'application/json',
          },
        );
        
        print('API Response Status: ${response.statusCode}');
        
        if (response.statusCode == 200) {
          final List<dynamic> jsonData = json.decode(response.body);
          print('Number of ads fetched: ${jsonData.length}');
          
          // Print details of each ad
          for (int i = 0; i < jsonData.length; i++) {
            final ad = jsonData[i];
            print('Ad $i:');
            print('  ID: ${ad['id']}');
            print('  Title: ${ad['title']}');
            print('  ImageUrl: ${ad['imageUrl']}');
            print('  ImageUrls: ${ad['imageUrls']}');
            print('  ImageUrls length: ${ad['imageUrls'] is List ? ad['imageUrls'].length : 'Not a list'}');
            print('  PositionInterval: ${ad['positionInterval']}');
            print('');
          }
          
          // Check the specific ads mentioned in the issue
          bool foundAd1 = false;
          bool foundAd2 = false;
          
          for (var ad in jsonData) {
            if (ad['id'] == '68fc67b3b355c0b3a98adf79') {
              foundAd1 = true;
              print('Found Ad 1 (single image):');
              print('  ImageUrls type: ${ad['imageUrls'].runtimeType}');
              print('  ImageUrls length: ${ad['imageUrls'].length}');
              print('  ImageUrls content: ${ad['imageUrls']}');
              expect(ad['imageUrls'].length, 1);
            }
            
            if (ad['id'] == '68fba12e06f2ad37d3239538') {
              foundAd2 = true;
              print('Found Ad 2 (multiple images):');
              print('  ImageUrls type: ${ad['imageUrls'].runtimeType}');
              print('  ImageUrls length: ${ad['imageUrls'].length}');
              print('  ImageUrls content: ${ad['imageUrls']}');
              expect(ad['imageUrls'].length, greaterThan(1));
            }
          }
          
          expect(foundAd1, true, reason: 'Ad 1 not found in API response');
          expect(foundAd2, true, reason: 'Ad 2 not found in API response');
        } else {
          print('Failed to fetch ads: ${response.statusCode}');
          print('Response body: ${response.body}');
        }
      } catch (e) {
        print('Error fetching ads: $e');
      }
    });
  });
}