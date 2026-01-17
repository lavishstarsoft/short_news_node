import 'package:flutter/material.dart';
import 'package:short_neww_app/models/ad_model.dart';
import 'ad_image_carousel.dart';

class DebugAdCarousel extends StatelessWidget {
  const DebugAdCarousel({super.key});

  @override
  Widget build(BuildContext context) {
    // Create test ads with the same data as in the API
    final adWithMultipleImages = AdModel(
      id: '68fba12e06f2ad37d3239538',
      title: 'Test Ad with Multiple Images',
      content: '',
      imageUrl: '/uploads/media-1761373607433-818942403.jpg',
      imageUrls: [
        '/uploads/media-1761373607433-818942403.jpg',
        '/uploads/media-1761373616394-63843915.jpg',
        '/uploads/media-1761373616415-263588608.png'
      ],
      linkUrl: '',
      positionInterval: 3,
      createdAt: DateTime.now(),
    );

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
      createdAt: DateTime.now(),
    );

    return Scaffold(
      appBar: AppBar(
        title: Text('Debug Ad Carousel'),
      ),
      body: SingleChildScrollView(
        child: Column(
          children: [
            SizedBox(height: 20),
            Text(
              'Ad with Multiple Images (Should show carousel)',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
            ),
            SizedBox(
              height: 300,
              child: AdImageCarousel(
                imageUrls: adWithMultipleImages.imageUrls,
                fit: BoxFit.cover,
              ),
            ),
            SizedBox(height: 20),
            Text(
              'Ad with Single Image (Should show directly)',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
            ),
            SizedBox(
              height: 300,
              child: AdImageCarousel(
                imageUrls: adWithSingleImage.imageUrls,
                fit: BoxFit.cover,
              ),
            ),
          ],
        ),
      ),
    );
  }
}