import 'package:flutter/material.dart';
import 'package:google_mobile_ads/google_mobile_ads.dart';
import '../services/admob_service.dart';

class AdMobBanner extends StatefulWidget {
  final VoidCallback? onAdLoaded;
  final VoidCallback? onAdFailedToLoad;
  final VoidCallback? onAdOpened;
  final VoidCallback? onAdClosed;

  const AdMobBanner({
    Key? key,
    this.onAdLoaded,
    this.onAdFailedToLoad,
    this.onAdOpened,
    this.onAdClosed,
  }) : super(key: key);

  @override
  State<AdMobBanner> createState() => _AdMobBannerState();
}

class _AdMobBannerState extends State<AdMobBanner> {
  BannerAd? _bannerAd;
  bool _isAdLoaded = false;
  bool _isAdLoading = false;

  @override
  void initState() {
    super.initState();
    _loadBannerAd();
  }

  @override
  void dispose() {
    _bannerAd?.dispose();
    super.dispose();
  }

  void _loadBannerAd() async {
    if (_isAdLoading) return;

    _isAdLoading = true;

    // Ensure AdMob is initialized
    if (!AdMobService.isInitialized) {
      await AdMobService.initialize();
    }

    // Create the banner ad
    _bannerAd = BannerAd(
      adUnitId: AdMobService.bannerAdUnitId,
      size: AdSize.banner,
      request: const AdRequest(),
      listener: BannerAdListener(
        onAdLoaded: (_) {
          if (mounted) {
            setState(() {
              _isAdLoaded = true;
              _isAdLoading = false;
            });
            widget.onAdLoaded?.call();
          }
        },
        onAdFailedToLoad: (ad, error) {
          debugPrint('Banner ad failed to load: ${error.message}');
          ad.dispose();
          if (mounted) {
            setState(() {
              _isAdLoaded = false;
              _isAdLoading = false;
            });
            widget.onAdFailedToLoad?.call();
          }
        },
        onAdOpened: (ad) {
          debugPrint('Banner ad opened');
          widget.onAdOpened?.call();
        },
        onAdClosed: (ad) {
          debugPrint('Banner ad closed');
          widget.onAdClosed?.call();
        },
      ),
    );

    // Load the ad
    await _bannerAd?.load();
  }

  @override
  Widget build(BuildContext context) {
    if (_isAdLoaded && _bannerAd != null) {
      // Show the ad when loaded
      return Container(
        width: _bannerAd!.size.width.toDouble(),
        height: _bannerAd!.size.height.toDouble(),
        alignment: Alignment.center,
        child: AdWidget(ad: _bannerAd!),
      );
    } else {
      // Show loading placeholder
      return Container(
        width: 320.0, // Standard banner width
        height: 50.0, // Standard banner height
        decoration: BoxDecoration(
          color: Colors.grey[200],
          borderRadius: BorderRadius.circular(4),
        ),
        alignment: Alignment.center,
        child: const Text(
          'Loading Advertisement...',
          style: TextStyle(fontSize: 12, color: Colors.grey),
        ),
      );
    }
  }
}
