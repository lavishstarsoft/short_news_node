import 'package:flutter/material.dart';
import 'widgets/debug_ad_carousel.dart';

void main() {
  runApp(DebugAdCarouselApp());
}

class DebugAdCarouselApp extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Debug Ad Carousel',
      theme: ThemeData(
        primarySwatch: Colors.blue,
      ),
      home: DebugAdCarousel(),
    );
  }
}