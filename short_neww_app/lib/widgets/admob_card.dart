import 'package:flutter/material.dart';
import 'package:google_mobile_ads/google_mobile_ads.dart';
import '../services/admob_service.dart';

class AdMobCard extends StatefulWidget {
  final String adId; // For tracking purposes
  final String adTitle; // For tracking purposes
  final VoidCallback? onAdLoaded;
  final VoidCallback? onAdFailedToLoad;

  const AdMobCard({
    Key? key,
    required this.adId,
    required this.adTitle,
    this.onAdLoaded,
    this.onAdFailedToLoad,
  }) : super(key: key);

  @override
  State<AdMobCard> createState() => _AdMobCardState();
}

class _AdMobCardState extends State<AdMobCard> {
  InterstitialAd? _interstitialAd;
  bool _isAdLoaded = false;
  bool _isAdLoading = false;
  bool _hasShownAd = false;

  @override
  void initState() {
    super.initState();
    _loadInterstitialAd();
  }

  @override
  void dispose() {
    _interstitialAd?.dispose();
    super.dispose();
  }

  void _loadInterstitialAd() async {
    if (_isAdLoading || _hasShownAd) return;

    _isAdLoading = true;

    try {
      // Load interstitial ad using service
      _interstitialAd = await AdMobService.createInterstitialAd(
        onAdLoaded: () {
          debugPrint('✅ InterstitialAd loaded for card: ${widget.adId}');
          if (mounted) {
            setState(() {
              _isAdLoaded = true;
              _isAdLoading = false;
            });
            widget.onAdLoaded?.call();
            
            // Automatically show the interstitial ad when loaded
            _showInterstitialAd();
          }
        },
        onAdFailedToLoad: () {
          debugPrint('❌ InterstitialAd failed to load: ${widget.adId}');
          if (mounted) {
            setState(() {
              _isAdLoaded = false;
              _isAdLoading = false;
              _interstitialAd = null;
            });
            widget.onAdFailedToLoad?.call();
          }
        },
        onAdDismissed: () {
          debugPrint('InterstitialAd dismissed: ${widget.adId}');
          if (mounted) {
            setState(() {
              _hasShownAd = true;
              _interstitialAd = null;
            });
          }
        },
      );
    } catch (e, stackTrace) {
      debugPrint('Error in _loadInterstitialAd: $e');
      debugPrint('Stack trace: $stackTrace');
      if (mounted) {
        setState(() {
          _isAdLoaded = false;
          _isAdLoading = false;
          _interstitialAd = null;
        });
        widget.onAdFailedToLoad?.call();
      }
    }
  }

  void _showInterstitialAd() {
    if (_interstitialAd != null && !_hasShownAd) {
      _interstitialAd!.show();
      _hasShownAd = true;
      debugPrint('✅ Showing InterstitialAd: ${widget.adId}');
    }
  }

  @override
  Widget build(BuildContext context) {
    // InterstitialAd is shown as full screen overlay, so we just show a placeholder card
    return Container(
      margin: const EdgeInsets.all(8.0),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12.0),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.1),
            blurRadius: 8.0,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(12.0),
        child: Container(
          height: 100.0,
          color: Colors.grey[100],
          child: Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                if (_isAdLoading)
                  const Text(
                    'Loading Advertisement...',
                    style: TextStyle(color: Colors.grey, fontSize: 12),
                  )
                else if (_isAdLoaded)
                  const Text(
                    'Advertisement',
                    style: TextStyle(color: Colors.grey, fontSize: 14),
                  )
                else
                  const Text(
                    'Advertisement',
                    style: TextStyle(color: Colors.grey, fontSize: 14),
                  ),
                const SizedBox(height: 4),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: Colors.blue,
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: const Text(
                    'Ad',
                    style: TextStyle(
                      color: Colors.white,
                      fontSize: 10,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
