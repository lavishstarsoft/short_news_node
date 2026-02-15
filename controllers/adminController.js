const Admin = require('../models/Admin');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const geoip = require('geoip-lite');
const requestIp = require('request-ip');
const iplocation = require('iplocation').default;
const fetch = require('node-fetch');
const mongoose = require('mongoose');

// Add these model imports
const News = require('../models/News');
const Location = require('../models/Location');
const Category = require('../models/Category');

// Import the Notification model
const Notification = require('../models/Notification');
const User = require('../models/User');

// Import OneSignal service
const oneSignalService = require('../services/oneSignalService');

// Render login page
const renderLoginPage = (req, res) => {
  res.render('login', { error: null });
};

// Advanced location detection function
const detectAdvancedLocation = async (ip) => {
  try {
    // Enhanced location details with better defaults
    let locationDetails = {
      city: 'Unknown',
      region: 'Unknown',
      country: 'Unknown',
      timezone: 'Unknown',
      isp: 'Unknown',
      latitude: null,
      longitude: null,
      isVpn: false,
      riskLevel: 'low',
      confidence: 100
    };

    // Handle localhost IPs specially
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
      locationDetails.city = 'Localhost';
      locationDetails.region = 'Local';
      locationDetails.country = 'Local';
      locationDetails.isp = 'Local Development';
      locationDetails.isVpn = true;
      locationDetails.riskLevel = 'high';
      locationDetails.confidence = 90;
      // Use default coordinates for localhost (somewhere in the ocean)
      locationDetails.latitude = 0.000000;
      locationDetails.longitude = 0.000000;

      return locationDetails;
    }

    // Get basic location from geoip-lite
    const geo = geoip.lookup(ip);

    if (geo) {
      locationDetails.city = geo.city || 'Unknown';
      locationDetails.region = geo.region || 'Unknown';
      locationDetails.country = geo.country || 'Unknown';
      locationDetails.timezone = geo.timezone || 'Unknown';
      // GeoIP-lite doesn't provide lat/long, so we'll fetch it separately
    }

    // Fetch latitude and longitude using iplocation
    try {
      const ipLocationData = await iplocation(ip);
      if (ipLocationData && ipLocationData.latitude && ipLocationData.longitude) {
        locationDetails.latitude = ipLocationData.latitude;
        locationDetails.longitude = ipLocationData.longitude;
      }

      // If we got location data from iplocation, use it to enhance our details
      if (ipLocationData) {
        if (ipLocationData.city && locationDetails.city === 'Unknown') {
          locationDetails.city = ipLocationData.city;
        }
        if (ipLocationData.region && locationDetails.region === 'Unknown') {
          locationDetails.region = ipLocationData.region;
        }
        if (ipLocationData.country && locationDetails.country === 'Unknown') {
          locationDetails.country = ipLocationData.country;
        }
      }
    } catch (ipLocationError) {
      console.log('IP location error:', ipLocationError);
    }

    // Check for VPN/proxy indicators
    const vpnIndicators = await checkVpnIndicators(ip);
    locationDetails.isVpn = vpnIndicators.isVpn;
    locationDetails.riskLevel = vpnIndicators.riskLevel;
    locationDetails.confidence = vpnIndicators.confidence;
    locationDetails.isp = vpnIndicators.isp || locationDetails.isp;

    // If we still don't have basic location info but have coordinates, 
    // try to reverse geocode them (simplified approach)
    if (locationDetails.city === 'Unknown' &&
      locationDetails.region === 'Unknown' &&
      locationDetails.country === 'Unknown' &&
      locationDetails.latitude &&
      locationDetails.longitude) {
      // This would be a good place to add reverse geocoding
      // For now, we'll just indicate we have coordinates
      locationDetails.city = 'Coordinates Only';
      locationDetails.region = 'Coordinates Only';
      locationDetails.country = 'Coordinates Only';
    }

    return locationDetails;
  } catch (error) {
    console.error('Advanced location detection error:', error);
    return {
      city: 'Error',
      region: 'Error',
      country: 'Error',
      timezone: 'Error',
      isp: 'Error',
      latitude: null,
      longitude: null,
      isVpn: false,
      riskLevel: 'low',
      confidence: 0
    };
  }
};

// Check for VPN/proxy indicators
const checkVpnIndicators = async (ip) => {
  const result = {
    isVpn: false,
    riskLevel: 'low',
    confidence: 100,
    isp: 'Unknown'
  };

  try {
    // Check against known VPN IP ranges (simplified check)
    // In a production environment, you would use a service like IPQualityScore or IPHub
    const suspiciousIps = [
      '127.0.0.1', // Localhost
      '::1'        // IPv6 localhost
    ];

    if (suspiciousIps.includes(ip)) {
      result.isVpn = true;
      result.riskLevel = 'high';
      result.confidence = 90;
      result.isp = 'Local/VPN Service';
      return result;
    }

    // Additional checks for VPN characteristics
    // This is a simplified implementation - in production you would use a dedicated service

    // Check if IP belongs to known datacenter ranges (simplified)
    if (ip.startsWith('10.') || ip.startsWith('172.') || ip.startsWith('192.168.')) {
      result.isVpn = true;
      result.riskLevel = 'medium';
      result.confidence = 70;
      result.isp = 'Private Network/Datacenter';
    }

    return result;
  } catch (error) {
    console.error('VPN detection error:', error);
    return result;
  }
};

// Handle login
const login = async (req, res) => {
  try {
    const { username, password, latitude, longitude, locationPermission } = req.body;

    // Validate input
    if (!username || !password) {
      return res.render('login', { error: 'Please provide username and password' });
    }

    // Check if location permission is granted
    if (locationPermission !== 'true') {
      return res.render('login', { error: 'Location permission is required to login. Please enable location permissions and try again.' });
    }

    // Validate that latitude and longitude are provided
    if (!latitude || !longitude) {
      return res.render('login', { error: 'Location data is required to login. Please enable location permissions and try again.' });
    }

    // Check if MongoDB is connected
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;

    let admin;

    if (isConnectedToMongoDB) {
      // Find admin by username in MongoDB
      admin = await Admin.findOne({ username });
    } else {
      // Use in-memory storage for admins
      const admins = req.app.locals.adminData || [];
      admin = admins.find(a => a.username === username);
    }

    // Check if admin exists
    if (!admin) {
      return res.render('login', { error: 'Invalid credentials' });
    }

    // Check if admin is active
    if (!admin.isActive) {
      return res.render('login', { error: 'Account is deactivated' });
    }

    // Compare password
    let isMatch;
    if (isConnectedToMongoDB) {
      isMatch = await admin.comparePassword(password);
    } else {
      // For in-memory storage, compare plain text (in a real app, you'd want to hash these too)
      isMatch = admin.password === password;
    }

    if (!isMatch) {
      return res.render('login', { error: 'Invalid credentials' });
    }

    // Get IP address using request-ip for better accuracy
    const ip = requestIp.getClientIp(req) || req.connection.remoteAddress || req.ip;

    // Get user agent
    const userAgent = req.headers['user-agent'] || 'Unknown';

    // Get advanced location information
    const locationDetails = await detectAdvancedLocation(ip);

    // Use client-side location data (highest priority)
    const clientLat = parseFloat(latitude);
    const clientLon = parseFloat(longitude);

    if (!isNaN(clientLat) && !isNaN(clientLon)) {
      locationDetails.latitude = clientLat;
      locationDetails.longitude = clientLon;
    }

    // Format location string with more detailed information
    let location = 'Unknown Location';
    const locationParts = [];

    // Build location string from available data
    if (locationDetails.city && locationDetails.city !== 'Unknown') {
      locationParts.push(locationDetails.city);
    }
    if (locationDetails.region && locationDetails.region !== 'Unknown') {
      locationParts.push(locationDetails.region);
    }
    if (locationDetails.country && locationDetails.country !== 'Unknown') {
      locationParts.push(locationDetails.country);
    }

    // If we have location parts, use them
    if (locationParts.length > 0) {
      location = locationParts.join(', ');
    } else if (locationDetails.isp && locationDetails.isp !== 'Unknown') {
      // Fallback to ISP if no location data
      location = locationDetails.isp;
    }

    // Add coordinates to location string for better identification
    if (locationDetails.latitude && locationDetails.longitude) {
      location += ` (${locationDetails.latitude.toFixed(6)}, ${locationDetails.longitude.toFixed(6)})`;
    }

    // Add warning for VPN usage
    if (locationDetails.isVpn) {
      location += ` [WARNING: Possible VPN detected - Risk Level: ${locationDetails.riskLevel}]`;
    }

    // Add login history with enhanced location details (only if MongoDB is connected)
    if (isConnectedToMongoDB) {
      await admin.addLoginHistory(ip, userAgent, location, locationDetails);

      // Update last login
      admin.lastLogin = new Date();
      await admin.save();
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: isConnectedToMongoDB ? admin._id : admin.id, username: admin.username, role: admin.role },
      process.env.JWT_SECRET || 'short_news_secret_key',
      { expiresIn: '24h' }
    );

    // Set cookie
    res.cookie('token', token, {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });

    // Redirect to dashboard
    res.redirect('/');
  } catch (error) {
    console.error('Login error:', error);
    res.render('login', { error: 'An error occurred during login' });
  }
};

// Handle logout
const logout = (req, res) => {
  res.clearCookie('token');
  res.redirect('/login');
};

// Render profile page
const renderProfilePage = async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.redirect('/login');
    }

    res.render('profile', { admin });
  } catch (error) {
    console.error('Profile error:', error);
    res.redirect('/login');
  }
};

// Handle profile update
const updateProfile = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const adminId = req.admin.id;

    // Find admin by ID
    const admin = await Admin.findById(adminId);
    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    // Verify current password
    const isMatch = await admin.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    // Update password
    admin.password = newPassword;
    await admin.save();

    res.json({ message: 'Profile updated successfully' });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'An error occurred while updating profile' });
  }
};

// Update profile image
const updateProfileImage = async (req, res) => {
  try {
    const adminId = req.admin.id;

    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    // Find admin by ID
    const admin = await Admin.findById(adminId);
    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }

<<<<<<< HEAD
    // Update profile image URL (Cloudinary path)
    // CloudinaryStorage returns path in file.path or file.secure_url (multer-storage-cloudinary usually puts it in path or path is local?)
    // Actually with multer-storage-cloudinary, file.path is usually the full URL.
    // Let's check upload.js or just use file.path which is standard for Cloudinary storage in multer.

    // Using file.path from multer-storage-cloudinary
    admin.profileImage = req.file.path;
=======
    // Update profile image URL (Cloudinary URL from multer)
    admin.avatar = req.file.path;
>>>>>>> a02007d6 (Initial commit)
    await admin.save();

    res.json({
      message: 'Profile image updated successfully',
<<<<<<< HEAD
      imageUrl: admin.profileImage
=======
      imageUrl: admin.avatar
>>>>>>> a02007d6 (Initial commit)
    });
  } catch (error) {
    console.error('Profile image update error:', error);
    res.status(500).json({ error: 'An error occurred while updating profile image' });
  }
};

// Render register editor page (only for admins/superadmins)
const renderRegisterEditorPage = async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.redirect('/login');
    }

    // Only admins and superadmins can register editors
    if (admin.role !== 'admin' && admin.role !== 'superadmin') {
      return res.status(403).send('Access denied. Admins only.');
    }

<<<<<<< HEAD
    // Fetch all locations for dropdown
    const locations = await Location.find().sort({ name: 1 });

    res.render('register-editor', { admin, error: null, locations });
=======
    res.render('register-editor', { admin, error: null });
>>>>>>> a02007d6 (Initial commit)
  } catch (error) {
    console.error('Register editor error:', error);
    res.redirect('/login');
  }
};

// Handle editor registration (only for admins/superadmins)
const registerEditor = async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.redirect('/login');
    }

    // Only admins and superadmins can register editors
    if (admin.role !== 'admin' && admin.role !== 'superadmin') {
      return res.status(403).send('Access denied. Admins only.');
    }

<<<<<<< HEAD
    const { username, email, password, name, location, displayRole, constituency, mobileNumber } = req.body;

    // Validate input
    if (!username || !email || !password) {
      return res.render('register-editor', { admin, error: 'Please provide all required fields', locations: await Location.find().sort({ name: 1 }) });
=======
    const { username, email, password } = req.body;

    // Validate input
    if (!username || !email || !password) {
      return res.render('register-editor', { admin, error: 'Please provide all required fields' });
>>>>>>> a02007d6 (Initial commit)
    }

    // Check if editor already exists
    const existingEditor = await Admin.findOne({ username });
    if (existingEditor) {
<<<<<<< HEAD
      return res.render('register-editor', { admin, error: 'Username already exists', locations: await Location.find().sort({ name: 1 }) });
=======
      return res.render('register-editor', { admin, error: 'Username already exists' });
>>>>>>> a02007d6 (Initial commit)
    }

    // Create new editor
    const newEditor = new Admin({
      username,
      email,
      password,
<<<<<<< HEAD
      role: 'editor',
      name: name || null,
      location: location || null,
      displayRole: displayRole || 'Reporter',
      constituency: constituency || null,
      mobileNumber: mobileNumber || null
=======
      role: 'editor'
>>>>>>> a02007d6 (Initial commit)
    });

    await newEditor.save();

    res.render('register-editor', { admin, error: null, success: 'Editor registered successfully' });
  } catch (error) {
    console.error('Editor registration error:', error);
    res.render('register-editor', { admin, error: 'An error occurred during registration' });
  }
};

<<<<<<< HEAD
=======
// Update editor
const updateEditor = async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Only admins and superadmins can update editors
    if (admin.role !== 'admin' && admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Access denied. Admins only.' });
    }

    const editorId = req.params.id;
    const { username, email, password, isActive } = req.body;

    const editor = await Admin.findById(editorId);
    if (!editor) {
      return res.status(404).json({ error: 'Editor not found' });
    }

    // Update fields
    if (username) editor.username = username;
    if (email) editor.email = email;
    if (password) editor.password = password; // Will be hashed by pre-save hook
    if (isActive !== undefined) editor.isActive = isActive;

    await editor.save();

    res.json({ message: 'Editor updated successfully', editor });
  } catch (error) {
    console.error('Update editor error:', error);
    res.status(500).json({ error: 'An error occurred while updating editor' });
  }
};

>>>>>>> a02007d6 (Initial commit)
// Render users list page with detailed interactions
const renderUsersListPage = async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.redirect('/login');
    }

    // Import User and News models
    const User = require('../models/User');
    const News = require('../models/News');

    // Get all users from database with populated interactions
    const users = await User.find()
      .sort({ createdAt: -1 })
      .populate([
        { path: 'interactions.likes', select: 'title category publishedAt' },
        { path: 'interactions.dislikes', select: 'title category publishedAt' },
        {
          path: 'interactions.comments.newsId',
          select: 'title publishedAt category'
        }
      ]);

    res.render('users', { admin, users });
  } catch (error) {
    console.error('Users list error:', error);
    res.status(500).send('Error fetching users list');
  }
};

// Render dashboard page
async function renderDashboard(req, res) {
  try {
    if (req.app.locals.isConnectedToMongoDB) {
      let newsList;
      let totalNewsCount;
      let activeNewsCount;
      let inactiveNewsCount;

      // Check user role
      if (req.admin.role === 'editor') {
        // Editors only see their own news
        newsList = await News.find({ authorId: req.admin.id }).sort({ publishedAt: -1 }).limit(12);
        totalNewsCount = await News.countDocuments({ authorId: req.admin.id });
        activeNewsCount = await News.countDocuments({ authorId: req.admin.id, isActive: true });
        inactiveNewsCount = await News.countDocuments({ authorId: req.admin.id, isActive: false });
      } else {
        // Admins and superadmins see all news, but limit to latest 12
        newsList = await News.find().sort({ publishedAt: -1 }).limit(12);
        totalNewsCount = await News.countDocuments();
        activeNewsCount = await News.countDocuments({ isActive: true });
        inactiveNewsCount = await News.countDocuments({ isActive: false });
      }

      const categories = await Category.find();
      const locations = await Location.find();

      // Get all locations to create a map of name to code
      const locationMap = {};
      locations.forEach(location => {
        locationMap[location.name] = location.code;
      });

      // Add location codes to news items
      const newsListWithCodes = newsList.map(news => {
        return {
          ...news.toObject(),
          locationCode: news.location ? locationMap[news.location] : null
        };
      });

      // Calculate today's news count
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      let todaysNewsCount;

      if (req.admin.role === 'editor') {
        // Editors only see their own today's news count
        todaysNewsCount = await News.countDocuments({
          authorId: req.admin.id,
          publishedAt: { $gte: today }
        });
      } else {
        // Admins and superadmins see all today's news count
        todaysNewsCount = await News.countDocuments({
          publishedAt: { $gte: today }
        });
      }

      res.render('index', {
        newsList: newsListWithCodes,
        categories,
        locations,
        todaysNewsCount,
        totalNewsCount,
        activeNewsCount,
        inactiveNewsCount,
        admin: req.admin
      });
    } else {
      // Use in-memory storage
      const newsData = req.app.locals.newsData || [];
      const categoryData = req.app.locals.categoryData || [];
      const locationData = req.app.locals.locationData || [];

      // Calculate counts for in-memory data
      const totalNewsCount = newsData.length;
      const activeNewsCount = newsData.filter(news => news.isActive !== false).length;
      const inactiveNewsCount = newsData.filter(news => news.isActive === false).length;

      // Calculate today's news count for in-memory data
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todaysNewsCount = newsData.filter(news => {
        const newsDate = new Date(news.publishedAt);
        newsDate.setHours(0, 0, 0, 0);
        return newsDate.getTime() === today.getTime();
      }).length;

      // Get all locations to create a map of name to code (for in-memory storage)
      const locationMap = {};
      locationData.forEach(location => {
        locationMap[location.name] = location.code;
      });

      // Add location codes to news items (for in-memory storage)
      // Limit to latest 12 news items
      const limitedNewsData = newsData
        .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
        .slice(0, 12);

      const newsListWithCodes = limitedNewsData.map(news => {
        return {
          ...news,
          locationCode: news.location ? locationMap[news.location] : null
        };
      });

      res.render('index', {
        newsList: newsListWithCodes,
        categories: categoryData,
        locations: locationData,
        todaysNewsCount,
        totalNewsCount,
        activeNewsCount,
        inactiveNewsCount,
        admin: req.admin
      });
    }
  } catch (error) {
    res.status(500).json({ error: 'Error fetching news' });
  }
}

// Render editors page
async function renderEditorsPage(req, res) {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.redirect('/login');
    }

    // Only admins and superadmins can view editors
    if (admin.role !== 'admin' && admin.role !== 'superadmin') {
      return res.status(403).send('Access denied. Admins only.');
    }

    // Get all editors
    const editors = await Admin.find({ role: 'editor' }).sort({ createdAt: -1 });

<<<<<<< HEAD
    // Fetch locations for edit dropdown
    const locations = await Location.find().sort({ name: 1 });

    res.render('editors', { admin, editors, locations });
=======
    res.render('editors', { admin, editors });
>>>>>>> a02007d6 (Initial commit)
  } catch (error) {
    console.error('Editors page error:', error);
    res.status(500).send('Error fetching editors');
  }
}

<<<<<<< HEAD
// Update editor (PUT /editors/:id)
async function updateEditor(req, res) {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Only admins and superadmins can update editors
    if (admin.role !== 'admin' && admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Access denied. Admins only.' });
    }

    const editorId = req.params.id;
    const { name, displayRole, location, constituency, mobileNumber } = req.body;

    const editor = await Admin.findById(editorId);
    if (!editor || editor.role !== 'editor') {
      return res.status(404).json({ error: 'Editor not found' });
    }

    // Update fields
    if (name !== undefined) editor.name = name || null;
    if (displayRole !== undefined) editor.displayRole = displayRole || 'Reporter';
    if (location !== undefined) editor.location = location || null;
    if (constituency !== undefined) editor.constituency = constituency || null;
    if (mobileNumber !== undefined) editor.mobileNumber = mobileNumber || null;

    await editor.save();

    res.json({
      message: 'Editor updated successfully',
      editor: {
        _id: editor._id,
        username: editor.username,
        name: editor.name,
        displayRole: editor.displayRole,
        location: editor.location,
        constituency: editor.constituency,
        mobileNumber: editor.mobileNumber
      }
    });
  } catch (error) {
    console.error('Update editor error:', error);
    res.status(500).json({ error: 'An error occurred while updating editor' });
  }
}

=======
>>>>>>> a02007d6 (Initial commit)
// Render reports page
async function renderReportsPage(req, res) {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.redirect('/login');
    }

    res.render('reports', { admin });
  } catch (error) {
    console.error('Reports page error:', error);
    res.status(500).send('Error fetching reports');
  }
}

// Send notification to all connected clients
async function sendNotification(req, res) {
  try {
    const { title, message, newsId, imageUrl, launchUrl, titleColor, platformSettings, priority } = req.body;

    // Validate input
    if (!title || !message) {
      return res.status(400).json({ error: 'Title and message are required' });
    }

    // If newsId is provided but launchUrl is not, automatically set the launch URL to the news detail page
    let finalLaunchUrl = launchUrl;
    if (newsId && !launchUrl) {
      // Set default launch URL to point to the news detail page
      finalLaunchUrl = `/news/${newsId}`;
    }

    // Set default small icon if not provided
    let finalPlatformSettings = platformSettings || {};
    if (!finalPlatformSettings.android) {
      finalPlatformSettings.android = {};
    }
    if (!finalPlatformSettings.android.icon) {
      // Use the OneSignal default icon
      finalPlatformSettings.android.icon = 'ic_stat_onesignal_default';
    }

    // Ensure LED settings are properly configured
    if (finalPlatformSettings.android.lights !== undefined) {
      if (finalPlatformSettings.android.lights) {
        // If LED is enabled, ensure timing is set
        if (finalPlatformSettings.android.ledOnMs === undefined) {
          finalPlatformSettings.android.ledOnMs = 1000;
        }
        if (finalPlatformSettings.android.ledOffMs === undefined) {
          finalPlatformSettings.android.ledOffMs = 1000;
        }
      }
    }

    // Get io instance from app locals
    const io = req.app.locals.io;
    const connectedClients = req.app.locals.connectedClients;

    if (!io) {
      return res.status(500).json({ error: 'WebSocket server not initialized' });
    }

    // Get all users to track recipients
    let allUsers = [];
    if (req.app.locals.isConnectedToMongoDB) {
      allUsers = await User.find({}, '_id');
    }

    // Prepare notification data
    const notificationData = {
      title,
      message,
      newsId: newsId || null,
      imageUrl: imageUrl || null,
      launchUrl: finalLaunchUrl || null,
      titleColor: titleColor || null, // Include title color in WebSocket notification
      platformSettings: finalPlatformSettings,
      priority: priority || 'normal',
      timestamp: new Date()
    };

    // Emit to all connected clients
    io.emit('admin_notification', notificationData);

    console.log('Sent admin notification to all clients:', notificationData);

    // Send OneSignal notification
    try {
      await oneSignalService.sendAdminNotification(title, message, {
        newsId: newsId || null,
        imageUrl: imageUrl || null,
        launchUrl: finalLaunchUrl || null,
        titleColor: titleColor || null,
        platformSettings: finalPlatformSettings,
        priority: priority || 'normal',
        ...notificationData
      });
      console.log('OneSignal admin notification sent');
    } catch (error) {
      console.error('Error sending OneSignal admin notification:', error);
    }

    // Create recipients list from connected clients
    const recipients = [];
    if (connectedClients) {
      for (let [userId, socketId] of connectedClients.entries()) {
        recipients.push({
          userId: userId,
          received: true, // Since we're sending now, mark as received
          receivedAt: new Date(),
          opened: false
        });
      }
    }

    // Add users who are not connected but exist in the database
    for (const user of allUsers) {
      const userId = user._id.toString();
      if (!recipients.find(r => r.userId === userId)) {
        recipients.push({
          userId: userId,
          received: false,
          opened: false
        });
      }
    }

    // Save notification to database
    const notification = new Notification({
      title,
      message,
      type: 'admin',
      priority: priority || 'normal',
      newsId: newsId || null,
      imageUrl: imageUrl || null,
      recipients: recipients,
      sentBy: req.admin.username,
      sentAt: new Date()
    });

    if (req.app.locals.isConnectedToMongoDB) {
      await notification.save();
      // Add the ID to the notification data sent to clients
      notificationData.id = notification._id;
    }

    res.json({
      message: 'Notification sent successfully',
      notification: notificationData
    });
  } catch (error) {
    console.error('Error sending notification:', error);
    res.status(500).json({ error: 'Error sending notification: ' + error.message });
  }
}

// Get notification statistics with enhanced data
async function getNotificationStats(req, res) {
  try {
    if (!req.app.locals.isConnectedToMongoDB) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    const totalNotifications = await Notification.countDocuments();

    const stats = await Notification.aggregate([
      {
        $group: {
          _id: '$priority',
          count: { $sum: 1 }
        }
      }
    ]);

    const priorityStats = {
      normal: 0,
      high: 0,
      urgent: 0
    };

    stats.forEach(stat => {
      priorityStats[stat._id] = stat.count;
    });

    // Get recent notifications (last 7 days)
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const recentNotifications = await Notification.find({
      sentAt: { $gte: oneWeekAgo }
    }).sort({ sentAt: -1 }).limit(5);

    // Get delivery statistics
    const deliveryStats = await Notification.aggregate([
      {
        $project: {
          totalRecipients: { $size: "$recipients" },
          openedRecipients: {
            $size: {
              $filter: {
                input: "$recipients",
                cond: "$$this.opened"
              }
            }
          },
          receivedRecipients: {
            $size: {
              $filter: {
                input: "$recipients",
                cond: "$$this.received"
              }
            }
          }
        }
      },
      {
        $group: {
          _id: null,
          totalRecipients: { $sum: "$totalRecipients" },
          totalOpened: { $sum: "$openedRecipients" },
          totalReceived: { $sum: "$receivedRecipients" }
        }
      }
    ]);

    const deliveryInfo = deliveryStats.length > 0 ? deliveryStats[0] : {
      totalRecipients: 0,
      totalOpened: 0,
      totalReceived: 0
    };

    res.json({
      total: totalNotifications,
      priorityStats,
      recentNotifications,
      deliveryStats: deliveryInfo
    });
  } catch (error) {
    console.error('Error fetching notification stats:', error);
    res.status(500).json({ error: 'Error fetching notification stats: ' + error.message });
  }
}

// Get notification by ID
async function getNotificationById(req, res) {
  try {
    if (!req.app.locals.isConnectedToMongoDB) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    const notification = await Notification.findById(req.params.id);
    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.json(notification);
  } catch (error) {
    console.error('Error fetching notification:', error);
    res.status(500).json({ error: 'Error fetching notification: ' + error.message });
  }
}

// Get notification history with pagination and filtering
async function getNotificationHistory(req, res) {
  try {
    if (!req.app.locals.isConnectedToMongoDB) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    // Get notifications with pagination
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Build filter query
    const filter = {};

    // Add type filter if provided
    if (req.query.type) {
      filter.type = req.query.type;
    }

    // Add priority filter if provided
    if (req.query.priority) {
      filter.priority = req.query.priority;
    }

    // Add date range filter if provided
    if (req.query.startDate || req.query.endDate) {
      filter.sentAt = {};
      if (req.query.startDate) {
        filter.sentAt.$gte = new Date(req.query.startDate);
      }
      if (req.query.endDate) {
        filter.sentAt.$lte = new Date(req.query.endDate);
      }
    }

    const notifications = await Notification.find(filter)
      .sort({ sentAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Notification.countDocuments(filter);

    res.json({
      notifications,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching notification history:', error);
    res.status(500).json({ error: 'Error fetching notification history: ' + error.message });
  }
}

// Get recent notifications (last 5)
async function getRecentNotifications(req, res) {
  try {
    if (!req.app.locals.isConnectedToMongoDB) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    // Get recent notifications (last 5)
    const recentNotifications = await Notification.find()
      .sort({ sentAt: -1 })
      .limit(5);

    res.json({
      recentNotifications
    });
  } catch (error) {
    console.error('Error fetching recent notifications:', error);
    res.status(500).json({ error: 'Error fetching recent notifications: ' + error.message });
  }
}

// Mark notification as opened by user
async function markNotificationOpened(req, res) {
  try {
    const { notificationId } = req.body;
    const userId = req.admin.id; // Assuming admin ID, but this should be user ID in real implementation

    if (!req.app.locals.isConnectedToMongoDB) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    const notification = await Notification.findById(notificationId);
    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    // Find the recipient and mark as opened
    const recipient = notification.recipients.find(r => r.userId === userId);
    if (recipient) {
      recipient.opened = true;
      recipient.openedAt = new Date();

      await notification.save();

      res.json({ message: 'Notification marked as opened' });
    } else {
      res.status(404).json({ error: 'Recipient not found' });
    }
  } catch (error) {
    console.error('Error marking notification as opened:', error);
    res.status(500).json({ error: 'Error marking notification as opened: ' + error.message });
  }
}

// Mark notification as received by user (for real-time tracking)
async function markNotificationReceived(req, res) {
  try {
    const { notificationId, userId } = req.body;

    if (!req.app.locals.isConnectedToMongoDB) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    const notification = await Notification.findById(notificationId);
    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    // Find the recipient and mark as received
    const recipient = notification.recipients.find(r => r.userId === userId);
    if (recipient) {
      // If already marked as opened, don't change that
      // But we can track when it was received
      if (!recipient.receivedAt) {
        recipient.receivedAt = new Date();
        await notification.save();
      }

      res.json({ message: 'Notification marked as received' });
    } else {
      res.status(404).json({ error: 'Recipient not found' });
    }
  } catch (error) {
    console.error('Error marking notification as received:', error);
    res.status(500).json({ error: 'Error marking notification as received: ' + error.message });
  }
}

// Render notifications page with history
async function renderNotificationsPage(req, res) {
  try {
    // Get notification stats
    let stats = {
      total: 0,
      priorityStats: { normal: 0, high: 0, urgent: 0 },
      recentNotifications: [],
      deliveryStats: {
        totalRecipients: 0,
        totalOpened: 0,
        totalReceived: 0
      }
    };

    if (req.app.locals.isConnectedToMongoDB) {
      const totalNotifications = await Notification.countDocuments();

      const notificationStats = await Notification.aggregate([
        {
          $group: {
            _id: '$priority',
            count: { $sum: 1 }
          }
        }
      ]);

      stats.priorityStats = {
        normal: 0,
        high: 0,
        urgent: 0
      };

      notificationStats.forEach(stat => {
        stats.priorityStats[stat._id] = stat.count;
      });

      stats.total = totalNotifications;

      // Get recent notifications (last 5)
      stats.recentNotifications = await Notification.find()
        .sort({ sentAt: -1 })
        .limit(5);

      // Get delivery statistics
      const deliveryStats = await Notification.aggregate([
        {
          $project: {
            totalRecipients: { $size: "$recipients" },
            openedRecipients: {
              $size: {
                $filter: {
                  input: "$recipients",
                  cond: "$$this.opened"
                }
              }
            },
            receivedRecipients: {
              $size: {
                $filter: {
                  input: "$recipients",
                  cond: "$$this.received"
                }
              }
            }
          }
        },
        {
          $group: {
            _id: null,
            totalRecipients: { $sum: "$totalRecipients" },
            totalOpened: { $sum: "$openedRecipients" },
            totalReceived: { $sum: "$receivedRecipients" }
          }
        }
      ]);

      stats.deliveryStats = deliveryStats.length > 0 ? deliveryStats[0] : {
        totalRecipients: 0,
        totalOpened: 0,
        totalReceived: 0
      };
    }

    res.render('notifications', {
      admin: req.admin,
      stats: stats
    });
  } catch (error) {
    console.error('Error rendering notifications page:', error);
    res.status(500).json({ error: 'Error rendering notifications page: ' + error.message });
  }
}

// Render OneSignal Analytics page
async function renderOneSignalAnalyticsPage(req, res) {
  try {
    res.render('onesignal-analytics', {
      admin: req.admin
    });
  } catch (error) {
    console.error('Error rendering OneSignal analytics page:', error);
    res.status(500).json({ error: 'Error rendering OneSignal analytics page: ' + error.message });
  }
}

// Authentication middleware
const requireAuth = (req, res, next) => {
  console.log('requireAuth called for path:', req.path); // Debug log
<<<<<<< HEAD
  console.log('Auth Header:', req.headers.authorization); // Debug log
  let token = req.cookies?.token;

  // Check Authorization header if cookie is missing
  if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }
=======
  const token = req.cookies?.token;
>>>>>>> a02007d6 (Initial commit)

  // Check if this is an API request (based on content type or accept header)
  const isApiRequest = req.path.startsWith('/api/') ||
    req.path.includes('/upload-') ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    (req.headers['content-type'] && req.headers['content-type'].includes('application/json'));

  console.log('Is API request:', isApiRequest); // Debug log

  if (!token) {
    console.log('No token found'); // Debug log
    if (isApiRequest) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    return res.redirect('/login');
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'short_news_secret_key');
    console.log('Token verified, admin:', decoded.username); // Debug log
    req.admin = decoded;
    next();
  } catch (error) {
    console.log('Token verification failed:', error.message); // Debug log
    if (isApiRequest) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    res.redirect('/login');
  }
};

// Check if admin is super admin
const requireSuperAdmin = (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.redirect('/login');
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'short_news_secret_key');

    if (decoded.role !== 'superadmin') {
      return res.status(403).send('Access denied. Super admin only.');
    }

    req.admin = decoded;
    next();
  } catch (error) {
    res.redirect('/login');
  }
};

// Check if user is admin or superadmin
const requireAdmin = (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.redirect('/login');
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'short_news_secret_key');

    if (decoded.role !== 'admin' && decoded.role !== 'superadmin') {
      return res.status(403).send('Access denied. Admins only.');
    }

    req.admin = decoded;
    next();
  } catch (error) {
    res.redirect('/login');
  }
};

// Check if user is editor
const requireEditor = (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.redirect('/login');
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'short_news_secret_key');

    if (decoded.role !== 'editor') {
      return res.status(403).send('Access denied. Editors only.');
    }

    req.admin = decoded;
    next();
  } catch (error) {
    res.redirect('/login');
  }
};

// Delete notification by ID
async function deleteNotification(req, res) {
  try {
    if (!req.app.locals.isConnectedToMongoDB) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    const notification = await Notification.findByIdAndDelete(req.params.id);
    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.json({ message: 'Notification deleted successfully' });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ error: 'Error deleting notification: ' + error.message });
  }
}

// Delete all notification history
async function deleteAllNotifications(req, res) {
  try {
    if (!req.app.locals.isConnectedToMongoDB) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    const result = await Notification.deleteMany({});

    res.json({
      message: `Successfully deleted ${result.deletedCount} notifications`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Error deleting all notifications:', error);
    res.status(500).json({ error: 'Error deleting all notifications: ' + error.message });
  }
}

// Get OneSignal analytics
async function getOneSignalAnalytics(req, res) {
  try {
    // Get app details
    let appDetails = null;
    try {
      appDetails = await oneSignalService.getAppDetails();
    } catch (error) {
      console.error('Error getting OneSignal app details:', error);
    }

    // Get recent notifications from OneSignal
    let recentNotifications = null;
    try {
      recentNotifications = await oneSignalService.getNotifications(10, 0);
    } catch (error) {
      console.error('Error getting OneSignal notifications:', error);
    }

    res.json({
      appDetails,
      recentNotifications
    });
  } catch (error) {
    console.error('Error fetching OneSignal analytics:', error);
    res.status(500).json({ error: 'Error fetching OneSignal analytics: ' + error.message });
  }
}

// Get user details by ID
async function getUserById(req, res) {
  try {
    const id = req.params.id;
    let user;

    // Check if it's a valid MongoDB ObjectId (must be 24 hex characters)
    if (mongoose.Types.ObjectId.isValid(id) && /^[0-9a-fA-F]{24}$/.test(id)) {
      try {
        user = await User.findById(id);
      } catch (err) {
        console.log('Not a valid ObjectId reference despite check:', id);
      }
    }

    // If not found by ObjectId, treat as Google ID
    if (!user) {
      user = await User.findOne({ googleId: id });
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Normalize data for frontend
    const userData = {
      _id: user.googleId || user._id, // Prefer Google ID for consistency if available
      username: user.displayName,
      email: user.email,
      phone: user.phone || 'Not provided',
      profilePic: user.photoUrl || user.profilePic || '/images/default-avatar.png',
      createdAt: user.createdAt,
      userType: user.googleId ? 'Google User' : 'Standard User'
    };

    res.json(userData);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Error fetching user details' });
  }
}

module.exports = {
  renderLoginPage,
  login,
  logout,
  requireAuth,
  requireAdmin,
  requireEditor,
  renderDashboard,
  renderProfilePage,
  updateProfile,
<<<<<<< HEAD
=======
  updateProfileImage,
>>>>>>> a02007d6 (Initial commit)
  renderRegisterEditorPage,
  registerEditor,
  renderEditorsPage,
  updateEditor,
  renderUsersListPage,
  getUserById,
  renderReportsPage, // Add this back
  renderNotificationsPage,
  sendNotification,
  getNotificationHistory,
  getNotificationStats,
  getRecentNotifications,
  getNotificationById,
  deleteNotification,
  deleteAllNotifications,
  markNotificationOpened,
  markNotificationReceived,
  renderOneSignalAnalyticsPage,
<<<<<<< HEAD
  getOneSignalAnalytics,
  updateProfileImage
=======
  getOneSignalAnalytics
>>>>>>> a02007d6 (Initial commit)
};