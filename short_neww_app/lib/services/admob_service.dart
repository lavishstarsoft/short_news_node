import 'dart:async';
import 'dart:io' show Platform;
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:google_mobile_ads/google_mobile_ads.dart';

class AdMobService {
  // Test Ad Unit IDs for development
  static const String _testBannerUnitId =
      'ca-app-pub-7694701196378549/8586501833'; // Test Banner Ad

  // Real Ad Unit IDs for production
  static const String _androidBannerAdUnitId =
      'ca-app-pub-7694701196378549/8586501833';
  static const String _iosBannerAdUnitId =
      'ca-app-pub-7694701196378549/8586501833'; // iOS ad unit ID

  // Instance variables
  static bool _isInitialized = false;

  /// Initialize the AdMob service
  static Future<void> initialize() async {
    if (_isInitialized) return;

    try {
      // Initialize with timeout
      await MobileAds.instance.initialize().timeout(
        const Duration(seconds: 10),
        onTimeout: () {
          debugPrint('⚠️ AdMob initialization timeout - continuing anyway');
          throw TimeoutException('AdMob initialization timeout', const Duration(seconds: 10));
        },
      );
      _isInitialized = true;
      debugPrint('✅ AdMob initialized successfully');
    } on TimeoutException {
      debugPrint('⚠️ AdMob initialization timed out - marking as initialized');
      _isInitialized = true; // Mark as initialized to prevent retries
    } catch (e, stackTrace) {
      debugPrint('❌ Error initializing AdMob: $e');
      debugPrint('Stack trace: $stackTrace');
      // Still mark as initialized to prevent infinite retries
      _isInitialized = true;
    }
  }

  /// Get the appropriate ad unit ID based on platform and build mode
  static String get bannerAdUnitId {
    if (kDebugMode) {
      // Always use test ads in debug mode
      return _testBannerUnitId;
    } else {
      // Use real ads in release mode
      if (Platform.isAndroid) {
        return _androidBannerAdUnitId;
      } else if (Platform.isIOS) {
        return _iosBannerAdUnitId;
      } else {
        // Fallback
        return _androidBannerAdUnitId;
      }
    }
  }

  /// Get the interstitial ad unit ID (same as banner for now)
  static String get interstitialAdUnitId {
    return bannerAdUnitId;
  }

  /// Create a standard banner ad
  static BannerAd createBannerAd() {
    return BannerAd(
      adUnitId: bannerAdUnitId,
      size: AdSize.banner,
      request: const AdRequest(),
      listener: BannerAdListener(
        onAdLoaded: (ad) => debugPrint('Banner ad loaded'),
        onAdFailedToLoad: (ad, error) {
          debugPrint('Banner ad failed to load: ${error.message}');
          ad.dispose();
        },
        onAdOpened: (ad) => debugPrint('Banner ad opened'),
        onAdClosed: (ad) => debugPrint('Banner ad closed'),
        onAdImpression: (ad) => debugPrint('Banner ad impression recorded'),
      ),
    );
  }

  /// Create a medium rectangle ad
  static BannerAd createMediumRectangleAd() {
    return BannerAd(
      adUnitId: bannerAdUnitId,
      size: AdSize.mediumRectangle,
      request: const AdRequest(),
      listener: BannerAdListener(
        onAdLoaded: (ad) => debugPrint('Medium rectangle ad loaded'),
        onAdFailedToLoad: (ad, error) {
          debugPrint('Medium rectangle ad failed to load: ${error.message}');
          ad.dispose();
        },
        onAdOpened: (ad) => debugPrint('Medium rectangle ad opened'),
        onAdClosed: (ad) => debugPrint('Medium rectangle ad closed'),
      ),
    );
  }

  /// Create and load an InterstitialAd
  static Future<InterstitialAd?> createInterstitialAd({
    VoidCallback? onAdLoaded,
    VoidCallback? onAdFailedToLoad,
    VoidCallback? onAdDismissed,
  }) async {
    try {
      // Ensure AdMob is initialized
      if (!_isInitialized) {
        await initialize();
        await Future.delayed(const Duration(milliseconds: 500));
      }

      InterstitialAd? interstitialAd;
      
      await InterstitialAd.load(
        adUnitId: interstitialAdUnitId,
        request: const AdRequest(),
        adLoadCallback: InterstitialAdLoadCallback(
          onAdLoaded: (ad) {
            interstitialAd = ad;
            debugPrint('✅ InterstitialAd loaded successfully');
            
            // Set up ad callbacks
            ad.fullScreenContentCallback = FullScreenContentCallback(
              onAdDismissedFullScreenContent: (ad) {
                debugPrint('InterstitialAd dismissed');
                ad.dispose();
                onAdDismissed?.call();
              },
              onAdFailedToShowFullScreenContent: (ad, error) {
                debugPrint('InterstitialAd failed to show: ${error.message}');
                ad.dispose();
              },
              onAdShowedFullScreenContent: (ad) {
                debugPrint('InterstitialAd showed full screen');
              },
            );
            
            onAdLoaded?.call();
          },
          onAdFailedToLoad: (error) {
            debugPrint('❌ InterstitialAd failed to load: ${error.message}');
            onAdFailedToLoad?.call();
          },
        ),
      );

      return interstitialAd;
    } catch (e, stackTrace) {
      debugPrint('❌ Error creating InterstitialAd: $e');
      debugPrint('Stack trace: $stackTrace');
      onAdFailedToLoad?.call();
      return null;
    }
  }

  /// Check if AdMob is initialized
  static bool get isInitialized => _isInitialized;
}
