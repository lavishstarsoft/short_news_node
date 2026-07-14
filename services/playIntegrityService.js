const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

/**
 * Service to interact with the Google Play Integrity API.
 * It uses a Service Account JSON file (e.g. play-integrity-key.json)
 * to authenticate with Google's servers and decode the token.
 */
class PlayIntegrityService {
  constructor() {
    this.keyFilePath = path.join(__dirname, '..', 'play-integrity-key.json');
    this.isConfigured = fs.existsSync(this.keyFilePath);
    
    // In a real production setup, you would fetch this dynamically or put it in .env
    // This is the package name of your Android app.
    this.packageName = process.env.PACKAGE_NAME || 'com.cbnyellowsingam.shortnews';
    
    if (this.isConfigured) {
      this.auth = new google.auth.GoogleAuth({
        keyFile: this.keyFilePath,
        scopes: ['https://www.googleapis.com/auth/playintegrity'],
      });
      this.playintegrity = google.playintegrity({ version: 'v1', auth: this.auth });
    }
  }

  /**
   * Decodes and verifies a Play Integrity Token from the client.
   * @param {String} integrityToken The token from the Android app
   * @returns {Object} result containing isValid and error details
   */
  async verifyToken(integrityToken) {
    if (!this.isConfigured) {
      console.warn('Play Integrity key missing. Skipping verification for testing purposes.');
      // WARNING: In production, return isValid: false if the key is missing!
      // For now, we return valid so as not to break the app while the user sets it up.
      return { isValid: true, reason: 'Skipped - Missing play-integrity-key.json' };
    }

    if (!integrityToken) {
      return { isValid: false, reason: 'Missing integrity token' };
    }

    try {
      const response = await this.playintegrity.v1.decodeIntegrityToken({
        packageName: this.packageName,
        requestBody: {
          integrityToken: integrityToken,
        },
      });

      const payload = response.data.tokenPayloadExternal;

      if (!payload) {
        return { isValid: false, reason: 'Empty token payload' };
      }

      // 1. Device Integrity Verification
      const deviceVerdict = payload.deviceIntegrity?.deviceRecognitionVerdict;
      const hasDeviceIntegrity = deviceVerdict && (
        deviceVerdict.includes('MEETS_DEVICE_INTEGRITY') ||
        deviceVerdict.includes('MEETS_STRONG_DEVICE_INTEGRITY')
      );

      // 2. App Integrity Verification
      const appVerdict = payload.appIntegrity?.appRecognitionVerdict;
      const hasAppIntegrity = appVerdict === 'PLAY_RECOGNIZED';

      // 3. Account Integrity Verification
      // Sometimes account details might not be present if the user isn't logged into Play Store.
      // But LICENSED is the strongest check.
      const accountVerdict = payload.accountDetails?.appLicensingVerdict;
      const hasAccountIntegrity = accountVerdict === 'LICENSED';

      const isValid = hasDeviceIntegrity && hasAppIntegrity;

      return {
        isValid,
        reason: isValid ? 'Verified' : 'Integrity checks failed',
        details: {
          deviceVerdict,
          appVerdict,
          accountVerdict
        }
      };
    } catch (error) {
      console.error('Play Integrity API Error:', error.message);
      return { isValid: false, reason: 'Token decoding failed', error: error.message };
    }
  }
}

module.exports = new PlayIntegrityService();
