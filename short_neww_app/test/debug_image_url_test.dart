import 'package:flutter_test/flutter_test.dart';
import 'package:short_neww_app/services/news_api_service.dart';

void main() {
  group('Debug Image URL Construction', () {
    test('Test getFullImageUrl method', () {
      // Test relative URL
      final relativeUrl = '/uploads/media-1761373607433-818942403.jpg';
      final fullUrl = NewsApiService.getFullImageUrl(relativeUrl);
      print('Relative URL: $relativeUrl');
      print('Full URL: $fullUrl');
      
      // Should construct full URL with base URL
      expect(fullUrl, startsWith('https://news.lavishstar.in/'));
      expect(fullUrl, endsWith('/uploads/media-1761373607433-818942403.jpg'));
      
      // Test absolute URL (should remain unchanged)
      final absoluteUrl = 'https://example.com/image.jpg';
      final processedAbsoluteUrl = NewsApiService.getFullImageUrl(absoluteUrl);
      print('Absolute URL: $absoluteUrl');
      print('Processed Absolute URL: $processedAbsoluteUrl');
      
      expect(processedAbsoluteUrl, equals(absoluteUrl));
      
      // Test URL without leading slash
      final noSlashUrl = 'uploads/media-1761373607433-818942403.jpg';
      final fullNoSlashUrl = NewsApiService.getFullImageUrl(noSlashUrl);
      print('No Slash URL: $noSlashUrl');
      print('Full No Slash URL: $fullNoSlashUrl');
      
      expect(fullNoSlashUrl, startsWith('https://news.lavishstar.in/'));
      expect(fullNoSlashUrl, endsWith('/uploads/media-1761373607433-818942403.jpg'));
    });
  });
}