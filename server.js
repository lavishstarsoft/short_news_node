const dotenv = require('dotenv');
dotenv.config();

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Structured logging. In production this also silences the many console.log
// debug statements so logs stay clean; warnings/errors are routed to the logger.
const { logger, installConsoleBridge } = require('./config/logger');
installConsoleBridge();

// Fail fast in production if critical secrets are missing instead of falling
// back to insecure hardcoded defaults.
(function validateRequiredEnv() {
  const required = ['MONGODB_URI', 'JWT_SECRET'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    const message = `Missing required environment variables: ${missing.join(', ')}`;
    if (IS_PRODUCTION) {
      console.error(`FATAL: ${message}. Refusing to start in production.`);
      process.exit(1);
    } else {
      console.warn(`WARNING: ${message}. Using local development fallbacks.`);
    }
  }
})();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
// const multer = require('multer');
// const ffmpeg = require('fluent-ffmpeg');
const cookieParser = require('cookie-parser');
const compression = require('compression'); // For response compression
const { OAuth2Client } = require('google-auth-library');

// WebSocket implementation
const http = require('http');
const socketIo = require('socket.io');

// Import models early
const News = require('./models/News');
const User = require('./models/User');
const Category = require('./models/Category');
const Location = require('./models/Location');
const Admin = require('./models/Admin');
const Report = require('./models/Report');

// Import the Notification model
const Notification = require('./models/Notification');

// Import OneSignal service
const oneSignalService = require('./services/oneSignalService');

// Import Redis configuration
const { isRedisAvailable, getCacheStats, closeRedisConnection } = require('./config/redis');

// GraphQL imports
const { ApolloServer } = require('apollo-server-express');
const typeDefs = require('./graphql/schema');
const resolvers = require('./graphql/resolvers');

// Initialize Google OAuth2 client
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID';
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

const app = express();
// Behind a reverse proxy (nginx/Cloudflare) in production so rate limiting and
// IP logging use the real client IP from X-Forwarded-For instead of the proxy.
app.set('trust proxy', IS_PRODUCTION ? 1 : false);
const PORT = process.env.PORT || 3001;

// Create HTTP server and attach Socket.IO
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    // Wildcard is valid here only because we do NOT use cookie credentials
    // over the socket (native clients authenticate via payload/token).
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: false
  }
});

// Store connected clients
const connectedClients = new Map();

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  let userId = null;

  // Register client with user ID
  socket.on('register', (registeredUserId) => {
    userId = registeredUserId;
    connectedClients.set(userId, socket.id);
    console.log(`User ${userId} registered with socket ${socket.id}`);
  });

  // Handle news received acknowledgment
  socket.on('news_received', async (data) => {
    console.log('News received acknowledgment:', data);
    try {
      if (mongoose.connection.readyState === 1) { // Check if MongoDB is connected
        // Find notifications related to this news item
        const notifications = await Notification.find({ newsId: data.newsId });
        for (const notification of notifications) {
          const recipient = notification.recipients.find(r => r.userId === data.userId);
          if (recipient && !recipient.received) {
            recipient.received = true;
            recipient.receivedAt = new Date(data.timestamp);
            await notification.save();
            console.log(`Marked notification ${notification._id} as received for user ${data.userId}`);
          }
        }
      }
    } catch (error) {
      console.error('Error marking news as received:', error);
    }
  });

  // Handle notification received acknowledgment
  socket.on('notification_received', async (data) => {
    console.log('Notification received acknowledgment:', data);
    try {
      if (mongoose.connection.readyState === 1) { // Check if MongoDB is connected
        const notification = await Notification.findById(data.notificationId);
        if (notification) {
          const recipient = notification.recipients.find(r => r.userId === data.userId);
          if (recipient && !recipient.received) {
            recipient.received = true;
            recipient.receivedAt = new Date(data.timestamp);
            await notification.save();
            console.log(`Marked notification ${notification._id} as received for user ${data.userId}`);
          }
        }
      }
    } catch (error) {
      console.error('Error marking notification as received:', error);
    }
  });

  // Handle notification opened acknowledgment
  socket.on('notification_opened', async (data) => {
    console.log('Notification opened acknowledgment:', data);
    try {
      if (mongoose.connection.readyState === 1) { // Check if MongoDB is connected
        const notification = await Notification.findById(data.notificationId);
        if (notification) {
          const recipient = notification.recipients.find(r => r.userId === data.userId);
          if (recipient && !recipient.opened) {
            recipient.opened = true;
            recipient.openedAt = new Date(data.timestamp);
            await notification.save();
            console.log(`Marked notification ${notification._id} as opened for user ${data.userId}`);
          }
        }
      }
    } catch (error) {
      console.error('Error marking notification as opened:', error);
    }
  });

  // Handle client disconnection
  socket.on('disconnect', () => {
    // Remove client from connected clients
    for (let [storedUserId, socketId] of connectedClients.entries()) {
      if (socketId === socket.id) {
        connectedClients.delete(storedUserId);
        console.log(`User ${storedUserId} disconnected`);
        break;
      }
    }
    console.log('Client disconnected:', socket.id);
  });
});

// Make io available to routes
app.locals.io = io;
app.locals.connectedClients = connectedClients;

// Import routes
const newsRoutes = require('./routes/newsRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const viralVideosRoutes = require('./routes/viralVideosRoutes');
const longVideosRoutes = require('./routes/longVideosRoutes');
const locationRoutes = require('./routes/locationRoutes');
const languageRoutes = require('./routes/languageRoutes');
const languageRegistry = require('./services/languageRegistry');
const adminRoutes = require('./routes/adminRoutes');
const publicRoutes = require('./routes/publicRoutes');
const adRoutes = require('./routes/adRoutes'); // Add this line for ads routes
const intelligentAdRoutes = require('./routes/intelligentAdRoutes'); // Add this line for intelligent ads routes
const cacheRoutes = require('./routes/cacheRoutes'); // Cache management routes
const appSettingsRoutes = require('./routes/appSettingsRoutes'); // App Settings route

// Import admin controller for middleware
const { requireAuth, requireAdmin, requireEditor } = require('./controllers/adminController');

// Import the login functions directly
const { renderLoginPage, login, logout, renderRegisterEditorPage, registerEditor, renderProfilePage, updateProfile, renderUsersListPage, renderEditorsPage, updateEditor } = require('./controllers/adminController');
const { renderReportsPage } = require('./controllers/newsController');
const newsController = require('./controllers/newsController');



// Middleware - ORDER MATTERS!
// Middleware - ORDER MATTERS!
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');

// Structured per-request logging (method, url, status, latency, request id).
app.use(pinoHttp({
  logger,
  autoLogging: {
    // Skip noisy health/asset/static requests to keep logs signal-rich.
    ignore: (req) =>
      req.url === '/favicon.ico' ||
      req.url.startsWith('/uploads') ||
      req.url.startsWith('/.well-known'),
  },
}));

// Security headers. CSP is disabled here because the admin dashboard uses
// inline scripts/styles and external CDNs; enable a tuned CSP later if needed.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
}));

app.use(compression()); // Compress all responses

// CORS: native mobile apps send no Origin header (and so are unaffected by
// CORS). For browsers we use an allowlist instead of the insecure '*' +
// credentials combination. Configure extra origins via CORS_ALLOWED_ORIGINS.
const defaultAllowedOrigins = [
  'https://news.lavishstar.in', 'https://report.cbnyellowsingam.in',
  'https://www.news.cbnyellowsingam.in', 'https://news.cbnyellowsingam.in',
  'https://www.news.tehelkanews.in', 'https://news.tehelkanews.in',
];
const allowedOrigins = new Set([
  ...defaultAllowedOrigins,
  ...((process.env.CORS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)),
]);

// Any localhost / 127.0.0.1 origin (any port) is allowed for local development.
const isLocalhostOrigin = (origin) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?$/.test(origin);

app.use(cors({
  origin(origin, callback) {
    // No origin = native app / curl / same-origin server call -> allow.
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin) || isLocalhostOrigin(origin)) {
      return callback(null, true);
    }
    // Disallowed: do NOT throw (that spams logs with stack traces and 500s).
    // Returning false simply omits CORS headers; the browser blocks it.
    return callback(null, false);
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
}));

// Rate limiting to blunt brute-force / scraping / abuse.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 1000,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(generalLimiter);

// Stricter limiter for authentication endpoints.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later.' },
});
app.use(['/login', '/admin/login', '/api/admin/login'], authLimiter);

// Handle JSON and URL-encoded data with large limits
app.use(express.json({ limit: '10mb' })); // Increase payload limit
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // Increase payload limit
app.use(cookieParser()); // Add cookie parser middleware

// 🚀 Explicit route for Android Digital Asset Links (MUST be an Array)
app.get(['/.well-known/assetlinks.json', '/assetlinks.json'], (req, res) => {
  const filePath = path.join(__dirname, 'public/.well-known/assetlinks.json');
  let data;

  if (fs.existsSync(filePath)) {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      data = JSON.parse(fileContent);
    } catch (e) {
      console.error('Error parsing assetlinks.json:', e);
    }
  }

  if (!data) {
    data = [{
      "relation": ["delegate_permission/common.handle_all_urls"],
      "target": {
        "namespace": "android_app",
        "package_name": "com.lavish.yellowsingam",
        "sha256_cert_fingerprints": [
          "B4:73:06:65:32:34:97:03:39:DB:B7:CA:13:57:4C:E7:19:A3:22:F4:08:F9:14:E5:14:26:67:51:76:C5:C1:74",
          "F3:26:02:62:64:0E:2D:F1:EA:6D:12:C5:5B:B0:B6:7C:E1:98:24:E7:9F:95:F9:77:28:37:51:EE:21:CD:45:FA"
        ]
      }
    }];
  }

  const finalArray = Array.isArray(data) ? data : [data];
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).send(JSON.stringify(finalArray));
});

// 🍎 Explicit route for Apple App Site Association (AASA)
app.get(['/.well-known/apple-app-site-association', '/apple-app-site-association'], (req, res) => {
  const filePath = path.join(__dirname, 'public/.well-known/apple-app-site-association');
  let data;

  if (fs.existsSync(filePath)) {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      data = JSON.parse(fileContent);
    } catch (e) {
      console.error('Error parsing AASA file:', e);
    }
  }

  if (!data) {
    data = {
      "applinks": {
        "apps": [],
        "details": [
          {
            "appID": "UW6F2VM6D8.com.lavish.yellowsingam",
            "paths": ["/news/*", "/*"]
          }
        ]
      }
    };
  }

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).send(JSON.stringify(data));
});

app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'allow' }));

// Mobile user authentication via verified Google ID token.
// SECURITY: The previous implementation treated `userToken === userId` as
// valid, which meant anyone who knew a user id could impersonate that user.
// That bypass has been removed — identity now comes only from a verified
// Google ID token (see middleware/mobileAuth.js).
const { verifyMobileUser } = require('./middleware/mobileAuth');
app.locals.verifyMobileUser = verifyMobileUser;
app.locals.googleAuthClient = client;

// Public API endpoint moved to publicRoutes.js with cache middleware
// DO NOT add duplicate routes here - use publicRoutes.js instead


// Set EJS as templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const { renderRichText, renderRichTextExcerpt, stripRichTags } = require('./utils/richTextRenderer');
app.locals.renderRichText = renderRichText;
app.locals.renderRichTextExcerpt = renderRichTextExcerpt;
app.locals.stripRichTags = stripRichTags;

// In-memory storage for news (fallback when MongoDB is not available)
let newsData = [
  {
    _id: '1',
    title: 'Sample News Article',
    content: 'This is a sample news article content.',
    imageUrl: '/uploads/sample1.jpg',
    category: 'Technology',
    location: 'Andhra Pradesh',
    publishedAt: new Date(),
    likes: 10,
    dislikes: 2,
    comments: 5,
    author: 'Admin',
    authorId: 'admin1',
    isActive: true // Add isActive field
  },
  {
    _id: '2',
    title: 'Another News Piece',
    content: 'This is another sample news article content.',
    imageUrl: '/uploads/sample2.jpg',
    category: 'Sports',
    location: 'Telangana',
    publishedAt: new Date(),
    likes: 15,
    dislikes: 1,
    comments: 8,
    author: 'Editor',
    authorId: 'editor1',
    isActive: true // Add isActive field
  }
];

// In-memory storage for categories (fallback when MongoDB is not available)
let categoryData = [
  {
    _id: '1',
    name: 'Technology',
    description: 'Latest technology news and updates',
    color: '#007bff',
    icon: 'fas fa-laptop',
    isActive: true,
    newsCount: 1,
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    _id: '2',
    name: 'Sports',
    description: 'Sports news and updates',
    color: '#28a745',
    icon: 'fas fa-futbol',
    isActive: true,
    newsCount: 1,
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    _id: '3',
    name: 'Health',
    description: 'Health and wellness news',
    color: '#dc3545',
    icon: 'fas fa-heart',
    isActive: true,
    newsCount: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    _id: '4',
    name: 'Entertainment',
    description: 'Entertainment and celebrity news',
    color: '#ffc107',
    icon: 'fas fa-music',
    isActive: true,
    newsCount: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    _id: '5',
    name: 'Business',
    description: 'Business and finance news',
    color: '#6f42c1',
    icon: 'fas fa-briefcase',
    isActive: true,
    newsCount: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    _id: '6',
    name: 'World',
    description: 'International news and events',
    color: '#17a2b8',
    icon: 'fas fa-globe',
    isActive: true,
    newsCount: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  }
];

// In-memory storage for locations
let locationData = [
  {
    _id: '1',
    name: 'Andhra Pradesh',
    code: 'AP',
    newsCount: 12,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    _id: '2',
    name: 'Telangana',
    code: 'TS',
    newsCount: 15,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date()
  }
];

// In-memory admin fallback (only used in local dev when MongoDB is down).
// Production requires MongoDB (server fails fast on missing MONGODB_URI), so
// this list stays empty there. Dev credentials come from env, never hardcoded.
let adminData = [];
if (!IS_PRODUCTION && process.env.DEV_ADMIN_USERNAME && process.env.DEV_ADMIN_PASSWORD) {
  adminData.push({
    id: 'admin1',
    username: process.env.DEV_ADMIN_USERNAME,
    email: process.env.DEV_ADMIN_EMAIL || 'admin@example.com',
    password: process.env.DEV_ADMIN_PASSWORD,
    role: 'superadmin',
    isActive: true,
    lastLogin: null,
    loginHistory: []
  });
}

// Variable to track MongoDB connection status
let isConnectedToMongoDB = false;

// Make data available to controllers
app.locals.isConnectedToMongoDB = isConnectedToMongoDB;
app.locals.newsData = newsData;
app.locals.categoryData = categoryData;
app.locals.locationData = locationData;
app.locals.adminData = adminData;

// Attempt to connect to MongoDB
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/short_news';
console.log('Attempting to connect to MongoDB...');

mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => {
    console.log('Connected to MongoDB successfully');
    isConnectedToMongoDB = true;
    app.locals.isConnectedToMongoDB = true; // Update the app locals

    // Create default admin after MongoDB connection is established
    console.log('MongoDB is connected, creating default admin...');
    return createDefaultAdmin()
      .then(() => languageRegistry.seedDefaultLanguages())
      .then(() => languageRegistry.syncReporterDefaultLanguages())
      .then(() => languageRegistry.refreshCache());
  })
  .catch((err) => {
    console.log('Failed to connect to MongoDB, using in-memory storage instead');
    console.log('MongoDB Error:', err.message);
    isConnectedToMongoDB = false;
    app.locals.isConnectedToMongoDB = false; // Update the app locals
  })
  .finally(() => {
    // Start server regardless of MongoDB connection status
    startServer();
  });

// Create default super admin if none exists
const createDefaultAdmin = async () => {
  try {
    if (!isConnectedToMongoDB) {
      console.log('MongoDB not connected, skipping default admin creation');
      return;
    }

    const adminCount = await Admin.countDocuments();
    console.log(`Found ${adminCount} admin users in database`);

    if (adminCount === 0) {
      // Only seed an initial admin from environment-provided credentials.
      // Never ship a hardcoded password. In production, if these are not set,
      // skip seeding and require the admin to be created manually.
      const seedUsername = process.env.DEFAULT_ADMIN_USERNAME;
      const seedPassword = process.env.DEFAULT_ADMIN_PASSWORD;
      const seedEmail = process.env.DEFAULT_ADMIN_EMAIL || 'admin@example.com';

      if (!seedUsername || !seedPassword) {
        console.warn(
          'No admins found and DEFAULT_ADMIN_USERNAME/PASSWORD not set. ' +
          'Skipping default admin creation — create one manually.'
        );
        return;
      }

      const defaultAdmin = new Admin({
        username: seedUsername,
        email: seedEmail,
        password: seedPassword,
        role: 'superadmin'
      });
      await defaultAdmin.save();
      console.log(`Default super admin created from env (username: ${seedUsername}).`);
    } else {
      console.log('Admin users already exist, skipping default admin creation');
      // Let's log the existing admins for debugging
      const admins = await Admin.find({}, 'username email role');
      console.log('Existing admins:', admins);
    }
  } catch (error) {
    console.error('Error creating default admin:', error);
  }
};

// Function to start the server
const startServer = async () => {
  try {
    // Redis connection is now initialized at top level (before routes load)
    // No need to connect again here

    // Initialize Apollo Server for GraphQL
    const depthLimit = require('graphql-depth-limit');
    const { createLoaders } = require('./graphql/loaders');
    const apolloServer = new ApolloServer({
      typeDefs,
      resolvers,
      // 🔒 Reject deeply-nested queries that can be used to overload the server.
      validationRules: [depthLimit(Number(process.env.GRAPHQL_DEPTH_LIMIT) || 10)],
      context: ({ req }) => ({
        req,
        io,
        connectedClients,
        // Per-request DataLoaders to batch author lookups (fixes N+1).
        loaders: createLoaders(),
      }),

      // 🔒 Security: Use bounded cache to prevent memory exhaustion attacks
      // This limits the cache size and prevents denial of service attacks
      cache: 'bounded',

      // 🔒 Disable schema introspection & playground in production so the full
      // API surface (including admin mutations) is not advertised publicly.
      introspection: !IS_PRODUCTION,
      playground: !IS_PRODUCTION,
    });

    // Start Apollo Server
    await apolloServer.start();

    // Apply Apollo middleware to Express
    apolloServer.applyMiddleware({
      app,
      path: '/graphql',
      cors: {
        origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3001', 'http://10.0.2.2:3001', 'https://news.lavishstar.in', 'http://192.168.0.127:3001', 'http://192.168.29.205:3000', 'http://192.168.29.205:3001', 'http://192.168.29.8:3000', 'http://192.168.29.8:3001', 'https://report.cbnyellowsingam.in'],
        credentials: true,
      },
    });

    console.log(`GraphQL endpoint available at http://localhost:${PORT}${apolloServer.graphqlPath}`);

    // Log Redis status
    console.log('\n=== Redis Cache Status ===');
    if (isRedisAvailable()) {
      console.log('✅ Redis cache is ENABLED and ready');
      try {
        const stats = await getCacheStats();
        console.log(`📊 Cache Statistics: Hits: ${stats.hits}, Misses: ${stats.misses}, Hit Rate: ${stats.hitRate}`);
        console.log(`🔑 Total Cached Keys: ${stats.totalKeys}`);
        console.log(`💾 ${stats.memoryInfo}`);
      } catch (error) {
        console.log('⚠️  Could not retrieve cache statistics');
      }
    } else {
      console.log('⚠️  Redis cache is DISABLED - running without cache');
      console.log('💡 To enable Redis: Ensure Redis server is running on localhost:6379');
    }
    console.log('===========================\n');

    // Start the HTTP server
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Server is running on 0.0.0.0:${PORT}`);
      console.log(`Visit http://localhost:${PORT} to view the dashboard`);
      console.log(`Network access: http://0.0.0.0:${PORT}`);
      console.log(`GraphQL Playground: http://localhost:${PORT}${apolloServer.graphqlPath}`);
      if (isRedisAvailable()) {
        console.log(`Cache Management: http://localhost:${PORT}/cache/management`);
      }
    });
  } catch (error) {
    console.error('Error starting server:', error);
    // Fallback: start server without GraphQL if there's an error
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Server is running on 0.0.0.0:${PORT} (GraphQL disabled due to error)`);
      console.log(`Visit http://localhost:${PORT} to view the dashboard`);
    });
  }
};

// Add the login routes at the root level to make them accessible at /login
app.get('/login', renderLoginPage);
app.post('/login', login);

// Add logout route at the root level
app.get('/logout', logout);

// Add reports page route at the root level

// Add register editor routes at the root level
app.get('/register-editor', requireAdmin, renderRegisterEditorPage);
app.post('/register-editor', requireAdmin, registerEditor);

// Registration Form & Applications
const { renderRegistrationFieldsPage, renderReporterApplicationsPage } = require('./controllers/adminController');
app.get('/registration-fields', requireAdmin, renderRegistrationFieldsPage);
app.get('/reporter-applications', requireAdmin, renderReporterApplicationsPage);

// Add profile route at the root level

// Add news routes at the root level
app.get('/news-list', requireAuth, newsController.renderNewsListPage);
app.get('/add-news', requireAuth, newsController.renderAddNewsPage);
app.get('/edit-news/:id', requireAuth, newsController.renderEditNewsPage);

// Add users list route at the root level

// Add reports API routes at the root level (as per project requirements)
const reportController = require('./controllers/reportController');

// Reports API endpoints (root level as per project requirements)

// SECURITY: All report endpoints are admin-only. They expose reporter data and
// allow moderation actions, so every route requires admin authentication.

// Comment Reports API endpoints (Must be before /reports/:status)
app.get('/reports/comments', requireAuth, reportController.getAllCommentReports);
app.put('/reports/comments/:id/status', requireAuth, reportController.updateCommentReportStatus);
app.delete('/reports/comments/:id/content', requireAuth, reportController.deleteCommentContent); // Route to delete actual comment content (More specific first)
app.delete('/reports/comments/:id', requireAuth, reportController.deleteCommentReport);

// General Reports API endpoints
app.get('/reports/stats', requireAuth, reportController.getReportStats);
app.get('/reports', requireAuth, reportController.getAllReports);
app.get('/reports/:status', requireAuth, reportController.getReportsByStatus);
app.put('/reports/:id/status', requireAuth, reportController.updateReportStatus);
app.delete('/reports/:id', requireAuth, reportController.deleteReport);

// Add root route to redirect to dashboard
app.get('/', (req, res) => {
  res.redirect('/news');
});

// Add editors route at the root level
app.get('/editors', requireAuth, renderEditorsPage);
app.put('/editors/:id', requireAuth, updateEditor);

// Redirect root path to ads list for backward compatibility
app.get('/ads', requireAuth, (req, res) => {
  res.redirect('/ads/ads');
});

// Use routes - reorganize to ensure proper isolation
app.use('/', publicRoutes); // Public API routes (already have /api/public prefix)
app.use('/admin', adminRoutes); // Admin routes with /admin prefix
app.use('/news', newsRoutes); // News routes with /news prefix
app.use('/categories', categoryRoutes);
app.use('/viral-videos', viralVideosRoutes);
app.use('/long-videos', longVideosRoutes);
app.use('/locations', locationRoutes);
app.use('/languages', languageRoutes);
app.use('/ads', adRoutes); // Add this line for ads routes
app.use('/intelligent-ads', intelligentAdRoutes); // Add this line for intelligent ads routes
app.use('/cache', cacheRoutes); // Cache management routes
app.use('/', appSettingsRoutes); // Ensure it catches /api/admin/app-settings and /api/public/app-settings

// Log all registered routes for debugging
console.log('Registered routes:');
app._router.stack.forEach((r) => {
  if (r.route && r.route.path) {
    console.log(r.route.path, Object.keys(r.route.methods));
  } else if (r.name === 'router' && r.handle && r.handle.stack) {
    // Log routes within router middleware
    r.handle.stack.forEach((subRoute) => {
      if (subRoute.route && subRoute.route.path) {
        console.log(r.regexp.source + subRoute.route.path, Object.keys(subRoute.route.methods));
      }
    });
  }
});

// Add specific logging for news routes
console.log('\nNews routes:');
app._router.stack.forEach((r) => {
  if (r.route && r.route.path && r.route.path.includes('/api/news')) {
    console.log(r.route.path, Object.keys(r.route.methods));
  } else if (r.name === 'router' && r.handle && r.handle.stack) {
    // Log routes within router middleware
    r.handle.stack.forEach((subRoute) => {
      if (subRoute.route && subRoute.route.path && subRoute.route.path.includes('/api/news')) {
        console.log(r.regexp.source + subRoute.route.path, Object.keys(subRoute.route.methods));
      }
    });
  }
});

// Log middleware stack for debugging
console.log('\nMiddleware stack:');
app._router.stack.forEach((r, i) => {
  if (r.name) {
    console.log(`${i}: ${r.name}`);
  }
  if (r.handle && r.handle.name) {
    console.log(`${i}: ${r.handle.name}`);
  }
});

// Start server
// Moved to startServer function above

