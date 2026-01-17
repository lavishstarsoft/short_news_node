import 'package:flutter_tts/flutter_tts.dart';

/// Service for Text-to-Speech functionality
/// Handles reading news articles aloud with voice controls
class TtsService {
  static final TtsService _instance = TtsService._internal();
  factory TtsService() => _instance;
  TtsService._internal();

  final FlutterTts _flutterTts = FlutterTts();
  bool _isInitialized = false;
  bool _isSpeaking = false;
  String? _currentNewsId;

  // Getters
  bool get isSpeaking => _isSpeaking;
  String? get currentNewsId => _currentNewsId;

  /// Initialize TTS with default settings
  Future<void> initialize() async {
    if (_isInitialized) return;

    try {
      // Set language (Telugu/English auto-detect)
      await _flutterTts.setLanguage("te-IN"); // Telugu

      // Set speech rate (0.5 = slow, 1.0 = normal, 1.5 = fast)
      await _flutterTts.setSpeechRate(0.5);

      // Set volume (0.0 to 1.0)
      await _flutterTts.setVolume(1.0);

      // Set pitch (0.5 to 2.0, 1.0 = normal)
      await _flutterTts.setPitch(1.0);

      // Set up completion handler
      _flutterTts.setCompletionHandler(() {
        _isSpeaking = false;
        _currentNewsId = null;
      });

      // Set up error handler
      _flutterTts.setErrorHandler((msg) {
        print('TTS Error: $msg');
        _isSpeaking = false;
        _currentNewsId = null;
      });

      _isInitialized = true;
      print('✅ TTS Service initialized successfully');
    } catch (e) {
      print('❌ TTS initialization error: $e');
    }
  }

  /// Speak the given text
  Future<void> speak(String text, String newsId) async {
    if (!_isInitialized) {
      await initialize();
    }

    try {
      // Stop current speech if any
      if (_isSpeaking) {
        await stop();
      }

      _currentNewsId = newsId;
      _isSpeaking = true;

      await _flutterTts.speak(text);
      print('🔊 Started speaking news: $newsId');
    } catch (e) {
      print('❌ TTS speak error: $e');
      _isSpeaking = false;
      _currentNewsId = null;
    }
  }

  /// Pause the current speech
  Future<void> pause() async {
    try {
      await _flutterTts.pause();
      print('⏸️ TTS paused');
    } catch (e) {
      print('❌ TTS pause error: $e');
    }
  }

  /// Stop the current speech
  Future<void> stop() async {
    try {
      await _flutterTts.stop();
      _isSpeaking = false;
      _currentNewsId = null;
      print('⏹️ TTS stopped');
    } catch (e) {
      print('❌ TTS stop error: $e');
    }
  }

  /// Check if currently speaking a specific news
  bool isSpeakingNews(String newsId) {
    return _isSpeaking && _currentNewsId == newsId;
  }

  /// Set speech rate
  Future<void> setSpeechRate(double rate) async {
    try {
      await _flutterTts.setSpeechRate(rate);
    } catch (e) {
      print('❌ TTS set speech rate error: $e');
    }
  }

  /// Set language
  Future<void> setLanguage(String language) async {
    try {
      await _flutterTts.setLanguage(language);
    } catch (e) {
      print('❌ TTS set language error: $e');
    }
  }

  /// Dispose TTS resources
  void dispose() {
    _flutterTts.stop();
  }
}
