const OneSignal = require('@onesignal/node-onesignal');

class OneSignalService {
  constructor() {
    // Initialize OneSignal client
    this.client = null;
    this.appId = process.env.ONESIGNAL_APP_ID;
    this.apiKey = process.env.ONESIGNAL_API_KEY;
    
    console.log('OneSignal config:', {
      appId: this.appId ? 'SET' : 'NOT SET',
      apiKey: this.apiKey ? 'SET' : 'NOT SET'
    });
    
    if (this.appId && this.apiKey) {
      this.initializeClient();
    } else {
      console.log('OneSignal not initialized - missing configuration');
    }
  }
  
  initializeClient() {
    try {
      // Configure the client with the correct authentication method
      const configuration = OneSignal.createConfiguration({
        restApiKey: process.env.ONESIGNAL_API_KEY, // App REST API key required for most endpoints
        basePath: 'https://api.onesignal.com'
      });
      
      this.client = new OneSignal.DefaultApi(configuration);
      console.log('OneSignal client initialized successfully');
    } catch (error) {
      console.error('Error initializing OneSignal client:', error);
    }
  }
  
  /**
   * Get app details
   * @returns {Promise<Object>} - App details
   */
  async getAppDetails() {
    if (!this.client) {
      throw new Error('OneSignal client not initialized. Check your configuration.');
    }
    
    try {
      const app = await this.client.getApp(this.appId);
      return app;
    } catch (error) {
      console.error('Error getting app details:', error);
      throw error;
    }
  }
  
  /**
   * Get notification details
   * @param {string} notificationId - Notification ID
   * @returns {Promise<Object>} - Notification details
   */
  async getNotificationDetails(notificationId) {
    if (!this.client) {
      throw new Error('OneSignal client not initialized. Check your configuration.');
    }
    
    try {
      const notification = await this.client.getNotification(this.appId, notificationId);
      return notification;
    } catch (error) {
      console.error('Error getting notification details:', error);
      throw error;
    }
  }
  
  /**
   * Get notifications
   * @param {number} limit - Number of notifications to retrieve
   * @param {number} offset - Offset for pagination
   * @returns {Promise<Object>} - Notifications list
   */
  async getNotifications(limit = 50, offset = 0) {
    if (!this.client) {
      throw new Error('OneSignal client not initialized. Check your configuration.');
    }
    
    try {
      const notifications = await this.client.getNotifications(this.appId, limit.toString(), offset);
      return notifications;
    } catch (error) {
      console.error('Error getting notifications:', error);
      throw error;
    }
  }
  
  /**
   * Send notification to all users
   * @param {string} title - Notification title
   * @param {string} message - Notification message
   * @param {Object} data - Additional data to send with notification
   * @returns {Promise<Object>} - Notification response
   */
  async sendNotificationToAll(title, message, data = {}) {
    if (!this.client) {
      throw new Error('OneSignal client not initialized. Check your configuration.');
    }
    
    try {
      const notification = new OneSignal.Notification();
      notification.app_id = this.appId;
      notification.contents = { en: message };
      notification.headings = { en: title };
      notification.data = data;
      notification.included_segments = ['All'];
      
      console.log('Sending notification with data:', {
        app_id: notification.app_id,
        contents: notification.contents,
        headings: notification.headings,
        included_segments: notification.included_segments
      });
      
      const response = await this.client.createNotification(notification);
      console.log('OneSignal notification sent successfully:', response);
      return response;
    } catch (error) {
      console.error('Error sending OneSignal notification:', {
        message: error.message,
        code: error.code,
        stack: error.stack
      });
      
      // Log the error body if available
      if (error.body) {
        error.body.text().then(text => {
          console.error('Error body:', text);
        }).catch(err => {
          console.error('Error reading error body:', err);
        });
      }
      
      throw error;
    }
  }
  
  /**
   * Send notification to specific users
   * @param {Array<string>} playerIds - Array of OneSignal player IDs
   * @param {string} title - Notification title
   * @param {string} message - Notification message
   * @param {Object} data - Additional data to send with notification
   * @returns {Promise<Object>} - Notification response
   */
  async sendNotificationToUsers(playerIds, title, message, data = {}) {
    if (!this.client) {
      throw new Error('OneSignal client not initialized. Check your configuration.');
    }
    
    if (!playerIds || playerIds.length === 0) {
      throw new Error('Player IDs are required');
    }
    
    try {
      const notification = new OneSignal.Notification();
      notification.app_id = this.appId;
      notification.contents = { en: message };
      notification.headings = { en: title };
      notification.data = data;
      notification.include_player_ids = playerIds;
      
      const response = await this.client.createNotification(notification);
      console.log('OneSignal notification sent to users:', response);
      return response;
    } catch (error) {
      console.error('Error sending OneSignal notification to users:', error);
      
      // Log the error body if available
      if (error.body) {
        error.body.text().then(text => {
          console.error('Error body:', text);
        }).catch(err => {
          console.error('Error reading error body:', err);
        });
      }
      
      throw error;
    }
  }
  
  /**
   * Send notification related to a news item
   * @param {Object} news - News object
   * @returns {Promise<Object>} - Notification response
   */
  async sendNewsNotification(news) {
    if (!this.client) {
      throw new Error('OneSignal client not initialized. Check your configuration.');
    }
    
    try {
      const title = `New News: ${news.title}`;
      const message = news.content.substring(0, 100) + (news.content.length > 100 ? '...' : '');
      const data = {
        type: 'news',
        newsId: news._id,
        title: news.title,
        content: news.content,
        mediaUrl: news.mediaUrl,
        mediaType: news.mediaType
      };
      
      return await this.sendNotificationToAll(title, message, data);
    } catch (error) {
      console.error('Error sending news notification:', error);
      throw error;
    }
  }
  
  /**
   * Send admin notification
   * @param {string} title - Notification title
   * @param {string} message - Notification message
   * @param {Object} data - Additional data
   * @returns {Promise<Object>} - Notification response
   */
  async sendAdminNotification(title, message, data = {}) {
    if (!this.client) {
      throw new Error('OneSignal client not initialized. Check your configuration.');
    }
    
    try {
      // Extract image URL, launch URL, title color and platform settings from data if provided
      const { imageUrl, launchUrl, titleColor, platformSettings, ...otherData } = data;
      
      const notificationData = {
        type: 'admin',
        titleColor: titleColor || null, // Include title color in the data sent to the app
        ...otherData
      };
      
      // Create notification object
      const notification = new OneSignal.Notification();
      notification.app_id = this.appId;
      notification.contents = { en: message };
      notification.headings = { en: title };
      notification.data = notificationData;
      notification.included_segments = ['All'];
      
      // Add URL if provided (this is the launch URL)
      if (launchUrl) {
        notification.url = launchUrl;
      }
      
      // Add title color if provided (Android only)
      if (titleColor) {
        // Convert hex color to the format expected by OneSignal
        // OneSignal expects colors in ARGB format
        const hexColor = titleColor.replace('#', '');
        if (hexColor.length === 6) {
          // Convert RGB to ARGB (add alpha channel)
          notification.android_accent_color = `FF${hexColor}`;
        }
      }
      
      // Add image if provided
      if (imageUrl) {
        // For Android, use big_picture for large image
        notification.big_picture = imageUrl;
        // For iOS, use ios_attachments
        notification.ios_attachments = { id1: imageUrl };
      }
      
      // Apply platform-specific settings if provided
      if (platformSettings) {
        // Android settings
        if (platformSettings.android) {
          if (platformSettings.android.sound !== undefined) {
            notification.android_sound = platformSettings.android.sound;
          }
          if (platformSettings.android.vibrate !== undefined) {
            notification.android_vibrate = platformSettings.android.vibrate;
          }
          if (platformSettings.android.lights !== undefined) {
            notification.android_led_color = platformSettings.android.lights ? "FF0000FF" : null; // Blue color
            // Add LED timing for older Android versions
            if (platformSettings.android.lights) {
              notification.android_led_on_ms = 1000;
              notification.android_led_off_ms = 1000;
            }
          }
          if (platformSettings.android.channel) {
            notification.android_channel_id = platformSettings.android.channel;
          }
          if (platformSettings.android.icon) {
            notification.small_icon = platformSettings.android.icon;
          }
          // Add new Android fields
          if (platformSettings.android.largeIcon) {
            notification.large_icon = platformSettings.android.largeIcon;
          }
          if (platformSettings.android.bigPicture) {
            notification.big_picture = platformSettings.android.bigPicture;
          }
        }
        
        // iOS settings
        if (platformSettings.ios) {
          if (platformSettings.ios.sound !== undefined) {
            notification.ios_sound = platformSettings.ios.sound ? "default" : null;
          }
          if (platformSettings.ios.badge !== undefined) {
            notification.ios_badgeType = platformSettings.ios.badge ? "Increase" : null;
            notification.ios_badgeCount = platformSettings.ios.badge ? "1" : null;
          }
          if (platformSettings.ios.contentAvailable !== undefined) {
            notification.content_available = platformSettings.ios.contentAvailable;
          }
          if (platformSettings.ios.category) {
            notification.ios_category = platformSettings.ios.category;
          }
        }
        
        // Web settings
        if (platformSettings.web) {
          if (platformSettings.web.sound !== undefined) {
            notification.web_sound = platformSettings.web.sound;
          }
          if (platformSettings.web.badge !== undefined) {
            notification.chrome_web_badge = platformSettings.web.badge ? "/badge.png" : null;
          }
          if (platformSettings.web.icon) {
            notification.chrome_web_icon = platformSettings.web.icon;
          }
        }
      }
      
      const response = await this.client.createNotification(notification);
      console.log('OneSignal admin notification sent:', response);
      return response;
    } catch (error) {
      console.error('Error sending admin notification:', error);
      
      // Log the error body if available
      if (error.body) {
        error.body.text().then(text => {
          console.error('Error body:', text);
        }).catch(err => {
          console.error('Error reading error body:', err);
        });
      }
      
      throw error;
    }
  }
}

module.exports = new OneSignalService();