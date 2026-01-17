# Google Mobile Ads ProGuard Rules
-keep class com.google.android.gms.ads.** { *; }
-keep class com.google.ads.** { *; }

# Keep AdRequest and related classes
-keep class com.google.android.gms.ads.AdRequest { *; }
-keep class com.google.android.gms.ads.AdRequest$Builder { *; }
-keep class com.google.android.gms.ads.AdRequest$** { *; }

# Keep AbstractAdRequestBuilder and related classes
-keep class com.google.android.gms.ads.AbstractAdRequestBuilder { *; }
-keep class com.google.android.gms.ads.internal.request.** { *; }

# Keep AdListener and related classes
-keep class com.google.android.gms.ads.AdListener { *; }
-keep class com.google.android.gms.ads.BannerAd { *; }
-keep class com.google.android.gms.ads.InterstitialAd { *; }
-keep class com.google.android.gms.ads.RewardedAd { *; }

# Keep AdSize and related classes
-keep class com.google.android.gms.ads.AdSize { *; }

# Keep AdView and related classes
-keep class com.google.android.gms.ads.AdView { *; }
-keep class com.google.android.gms.ads.BaseAdView { *; }

# Keep MobileAds class
-keep class com.google.android.gms.ads.MobileAds { *; }

# Keep all native methods
-keepclasseswithmembernames class * {
    native <methods>;
}

# Keep Google Play Services
-keep class com.google.android.gms.** { *; }
-dontwarn com.google.android.gms.**

# Keep Flutter plugins
-keep class io.flutter.plugins.googlemobileads.** { *; }

