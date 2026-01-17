import 'package:flutter_test/flutter_test.dart';
import 'package:short_neww_app/models/ad_model.dart';
import 'dart:convert';

void main() {
  group('API Ad Data', () {
    test('AdModel should correctly parse imageUrls field', () {
      // Test data with multiple images
      final jsonData = {
        "id": "68fba12e06f2ad37d3239538",
        "title": "Test Ad",
        "content": "",
        "imageUrl": "/uploads/media-1761321248334-352248144.jpg",
        "imageUrls": [
          "/uploads/media-1761321248334-352248144.jpg",
          "/uploads/media-1761321248351-168885750.jpg",
          "/uploads/media-1761321248373-549821972.jpg"
        ],
        "linkUrl": "",
        "positionInterval": 3,
        "createdAt": "2025-10-24T15:54:22.586Z"
      };
      
      // Parse the JSON data
      final ad = AdModel.fromJson(jsonData);
      
      // Verify the ad model correctly parses the data
      expect(ad.id, '68fba12e06f2ad37d3239538');
      expect(ad.title, 'Test Ad');
      expect(ad.imageUrls.length, 3);
      expect(ad.imageUrls[0], '/uploads/media-1761321248334-352248144.jpg');
      expect(ad.imageUrls[1], '/uploads/media-1761321248351-168885750.jpg');
      expect(ad.imageUrls[2], '/uploads/media-1761321248373-549821972.jpg');
      expect(ad.positionInterval, 3);
    });
    
    test('AdModel should handle single image fallback', () {
      // Test data with only imageUrl (backward compatibility)
      final jsonData = {
        "id": "68fc67b3b355c0b3a98adf79",
        "title": "Test Ad",
        "content": "",
        "imageUrl": "/uploads/media-1761372078718-325466223.jpg",
        "linkUrl": "",
        "positionInterval": 5,
        "createdAt": "2025-10-25T06:01:23.487Z"
      };
      
      // Parse the JSON data
      final ad = AdModel.fromJson(jsonData);
      
      // Verify the ad model correctly parses the data
      expect(ad.id, '68fc67b3b355c0b3a98adf79');
      expect(ad.title, 'Test Ad');
      expect(ad.imageUrls.length, 1);
      expect(ad.imageUrls[0], '/uploads/media-1761372078718-325466223.jpg');
      expect(ad.positionInterval, 5);
    });
  });
}