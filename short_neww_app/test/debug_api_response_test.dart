import 'package:flutter_test/flutter_test.dart';
import 'package:short_neww_app/models/ad_model.dart';
import 'dart:convert';

void main() {
  group('Debug API Response', () {
    test('Parse actual API response examples', () {
      // Example API response for ad with single image
      final singleImageAdJson = {
        "id": "68fc67b3b355c0b3a98adf79",
        "title": " ",
        "content": "",
        "imageUrl": "/uploads/media-1761372078718-325466223.jpg",
        "imageUrls": [
          "/uploads/media-1761372078718-325466223.jpg"
        ],
        "linkUrl": "",
        "positionInterval": 5,
        "createdAt": "2025-10-25T06:01:23.487Z"
      };
      
      // Example API response for ad with multiple images
      final multipleImagesAdJson = {
        "id": "68fba12e06f2ad37d3239538",
        "title": " ",
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
      final singleImageAd = AdModel.fromJson(singleImageAdJson);
      final multipleImagesAd = AdModel.fromJson(multipleImagesAdJson);
      
      print('Single image ad imageUrls length: ${singleImageAd.imageUrls.length}');
      print('Multiple images ad imageUrls length: ${multipleImagesAd.imageUrls.length}');
      
      expect(singleImageAd.imageUrls.length, 1);
      expect(multipleImagesAd.imageUrls.length, 3);
      
      // Verify the actual values
      expect(singleImageAd.imageUrls[0], '/uploads/media-1761372078718-325466223.jpg');
      expect(multipleImagesAd.imageUrls[0], '/uploads/media-1761321248334-352248144.jpg');
      expect(multipleImagesAd.imageUrls[1], '/uploads/media-1761321248351-168885750.jpg');
      expect(multipleImagesAd.imageUrls[2], '/uploads/media-1761321248373-549821972.jpg');
    });
  });
}