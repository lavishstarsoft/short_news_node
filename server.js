const dotenv = require('dotenv');
dotenv.config();

console.log('DEBUG: REDIS_URL is:', process.env.REDIS_URL);
console.log('DEBUG: REDIS_HOST is:', process.env.REDIS_HOST);

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
// const multer = require('multer');
// const ffmpeg = require('fluent-ffmpeg');
const cookieParser = require('cookie-parser');
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
const PORT = process.env.PORT || 3001;

// Create HTTP server and attach Socket.IO
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3001', 'http://10.0.2.2:3001', 'https://news.lavishstar.in', 'http://192.168.0.127:3001', 'http://192.168.29.205:3000', 'http://192.168.29.205:3001', 'http://192.168.29.8:3000', 'http://192.168.29.8:3001', 'https://short-news-next-reporters.vercel.app', 'https://cbnyellowsingam.in', 'https://www.cbnyellowsingam.in'],
    methods: ['GET', 'POST'],
    credentials: true
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
const locationRoutes = require('./routes/locationRoutes');
const adminRoutes = require('./routes/adminRoutes');
const publicRoutes = require('./routes/publicRoutes');
const adRoutes = require('./routes/adRoutes'); // Add this line for ads routes
const intelligentAdRoutes = require('./routes/intelligentAdRoutes'); // Add this line for intelligent ads routes
const cacheRoutes = require('./routes/cacheRoutes'); // Cache management routes

// Import admin controller for middleware
const { requireAuth, requireAdmin, requireEditor } = require('./controllers/adminController');

// Import the login functions directly
const { renderLoginPage, login, logout, renderRegisterEditorPage, registerEditor, renderProfilePage, updateProfile, renderUsersListPage, renderEditorsPage, updateEditor } = require('./controllers/adminController');
const { renderReportsPage } = require('./controllers/newsController');
const newsController = require('./controllers/newsController');



// Middleware - ORDER MATTERS!
// Middleware - ORDER MATTERS!
// CORS must be first to handle preflight requests
app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3001', 'http://10.0.2.2:3001', 'https://news.lavishstar.in', 'http://192.168.0.127:3001', 'http://192.168.29.205:3000', 'http://192.168.29.205:3001', 'http://192.168.29.8:3000', 'http://192.168.29.8:3001', 'https://short-news-next-reporters.vercel.app'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
}));

// Handle JSON and URL-encoded data with large limits
app.use(express.json({ limit: '10mb' })); // Increase payload limit
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // Increase payload limit
app.use(cookieParser()); // Add cookie parser middleware

// Static files
// app.use(express.static(path.join(__dirname, 'public'))); -> This was in original line 186, I should keep it?
// Line 186 was: app.use(express.static(path.join(__dirname, 'public')));
// My EndLine is 185. So 186 remains.

app.use(express.static(path.join(__dirname, 'public')));

// Google authentication verification middleware
const verifyGoogleToken = async (req, res, next) => {
  try {
    const { userId, userToken } = req.body;

    // Check if userId and userToken are provided
    if (!userId || !userToken) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Check if this is a mobile user (simple token)
    // Mobile tokens are just the user ID, while Google tokens are JWT tokens
    if (userToken === userId) {
      // This is likely a mobile user, verify against database
      const user = await User.findById(userId);

      if (!user) {
        return res.status(401).json({ error: 'Invalid authentication token' });
      }

      // Token is valid for mobile user, proceed to next middleware
      next();
      return;
    }

    // This is a Google user, verify the Google ID token
    const ticket = await client.verifyIdToken({
      idToken: userToken,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const userid = payload['sub'];

    // Check if the user ID matches
    if (userid !== userId) {
      return res.status(401).json({ error: 'Invalid authentication token' });
    }

    // Token is valid, proceed to next middleware
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(401).json({ error: 'Invalid authentication token' });
  }
};

// Make the verifyGoogleToken middleware and client available to routes
app.locals.verifyGoogleToken = verifyGoogleToken;
app.locals.googleAuthClient = client;

// Public API endpoint moved to publicRoutes.js with cache middleware
// DO NOT add duplicate routes here - use publicRoutes.js instead


// Set EJS as templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

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

// In-memory storage for admins (fallback when MongoDB is not available)
let adminData = [
  {
    id: 'admin1',
    username: 'superadmin',
    email: 'superadmin@example.com',
    password: 'superadmin123', // In a real app, this should be hashed
    role: 'superadmin',
    isActive: true,
    lastLogin: null,
    loginHistory: []
  },
  {
    id: 'editor1',
    username: 'editor',
    email: 'editor@example.com',
    password: 'editor123', // In a real app, this should be hashed
    role: 'editor',
    isActive: true,
    lastLogin: null,
    loginHistory: []
  }
];

// Variable to track MongoDB connection status
let isConnectedToMongoDB = false;

// Make data available to controllers
app.locals.isConnectedToMongoDB = isConnectedToMongoDB;
app.locals.newsData = newsData;
app.locals.categoryData = categoryData;
app.locals.locationData = locationData;
app.locals.adminData = adminData;

// Attempt to connect to MongoDB
const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://ashokca810:ashokca810@cluster0.psirpqa.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
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
    return createDefaultAdmin();
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
      const defaultAdmin = new Admin({
        username: 'superadmin',
        email: 'superadmin@example.com',
        password: 'superadmin123',
        role: 'superadmin'
      });
      await defaultAdmin.save();
      console.log('Default super admin created:');
      console.log('Username: superadmin');
      console.log('Password: superadmin123');
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
    const apolloServer = new ApolloServer({
      typeDefs,
      resolvers,
      context: ({ req }) => ({
        req,
        io,
        connectedClients,
      }),

      // 🔒 Security: Use bounded cache to prevent memory exhaustion attacks
      // This limits the cache size and prevents denial of service attacks
      cache: 'bounded',

      introspection: true, // Enable GraphQL Playground in development
      playground: true,
    });

    // Start Apollo Server
    await apolloServer.start();

    // Apply Apollo middleware to Express
    apolloServer.applyMiddleware({
      app,
      path: '/graphql',
      cors: {
        origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3001', 'http://10.0.2.2:3001', 'https://news.lavishstar.in', 'http://192.168.0.127:3001', 'http://192.168.29.205:3000', 'http://192.168.29.205:3001', 'http://192.168.29.8:3000', 'http://192.168.29.8:3001'],
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

// Add profile route at the root level

// Add news routes at the root level
app.get('/news-list', requireAuth, newsController.renderNewsListPage);
app.get('/add-news', requireAuth, newsController.renderAddNewsPage);
app.get('/edit-news/:id', requireAuth, newsController.renderEditNewsPage);

// Add users list route at the root level

// Add reports API routes at the root level (as per project requirements)
const reportController = require('./controllers/reportController');

// Reports API endpoints (root level as per project requirements)

// Comment Reports API endpoints (Must be before /reports/:status)
app.get('/reports/comments', reportController.getAllCommentReports);
app.put('/reports/comments/:id/status', reportController.updateCommentReportStatus);
app.delete('/reports/comments/:id/content', reportController.deleteCommentContent); // Route to delete actual comment content (More specific first)
app.delete('/reports/comments/:id', reportController.deleteCommentReport);

// General Reports API endpoints
app.get('/reports/stats', reportController.getReportStats);
app.get('/reports', reportController.getAllReports);
app.get('/reports/:status', reportController.getReportsByStatus);
app.put('/reports/:id/status', reportController.updateReportStatus);
app.delete('/reports/:id', reportController.deleteReport);

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
app.use('/locations', locationRoutes);
app.use('/ads', adRoutes); // Add this line for ads routes
app.use('/intelligent-ads', intelligentAdRoutes); // Add this line for intelligent ads routes
app.use('/cache', cacheRoutes); // Cache management routes

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

