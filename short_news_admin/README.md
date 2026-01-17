# Short News Admin Dashboard

This is a Node.js admin dashboard for managing news content in the Short News Flutter app.

## Features

- Dashboard overview with statistics
- Add new news articles
- Edit existing news articles
- Delete news articles
- View all news articles in a card layout
- Category management
- Ad management with intelligent controls
- User management (coming soon)
- Analytics (coming soon)
- Real-time notifications via WebSocket

## Prerequisites

- Node.js (v14 or higher)
- MongoDB (local or remote instance)
- npm or yarn

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   ```

2. Navigate to the project directory:
   ```bash
   cd short_news_admin_dashboard
   ```

3. Install dependencies:
   ```bash
   npm install
   ```

4. Set up environment variables:
   Create a `.env` file in the root directory with the following variables:
   ```
   MONGODB_URI=mongodb://localhost:27017/shortnews
   PORT=3000
   JWT_SECRET=your_jwt_secret_key
   ```

5. Start MongoDB (if using local instance):
   ```bash
   mongod
   ```

6. Run the application:
   ```bash
   npm start
   ```

   For development with auto-reload:
   ```bash
   npm run dev
   ```

## Project Structure

```
short_news_admin_dashboard/
├── controllers/          # Route controllers
├── models/               # Database models
├── routes/               # API routes
├── views/                # EJS templates
├── public/               # Static files (CSS, JS, images)
├── server.js             # Main application file
├── package.json          # Project dependencies
└── .env                  # Environment variables
```

## API Endpoints

### News Management

- `GET /api/news` - Get all news articles
- `POST /api/news` - Create a new news article
- `PUT /api/news/:id` - Update a news article
- `DELETE /api/news/:id` - Delete a news article

### Ad Management

- `GET /ads` - View ads management interface
- `GET /ads/ads` - Get all ads
- `POST /ads/ads` - Create a new ad
- `PUT /ads/ads/:id` - Update an ad
- `DELETE /ads/ads/:id` - Delete an ad
- `PUT /ads/ads/:id/toggle-status` - Toggle ad active status

### Intelligent Ad Management

- `GET /intelligent-ads` - View intelligent ads management dashboard
- `PUT /intelligent-ads/ads/:id/frequency` - Update ad frequency settings
- `GET /intelligent-ads/analytics` - Get ad performance analytics
- `POST /intelligent-ads/analytics/reset` - Reset ad analytics data

## WebSocket Implementation

The dashboard now supports real-time notifications using WebSocket (Socket.IO):

- When a new news article is created, all connected Flutter app users receive an immediate notification
- Users can choose to view the new news immediately when notified
- See [WEBSOCKET_IMPLEMENTATION.md](../WEBSOCKET_IMPLEMENTATION.md) for detailed implementation information

### Testing WebSocket

To test the WebSocket functionality:

1. Run the test client:
   ```bash
   node test_websocket.js
   ```

2. Create a new news article through the admin dashboard
3. The test client should receive a notification about the new news

## Database Schema

### News Model

```javascript
{
  title: String,        // Required
  content: String,      // Required
  imageUrl: String,     // Required
  category: String,     // Required
  publishedAt: Date,    // Default: Date.now()
  likes: Number,        // Default: 0
  dislikes: Number,     // Default: 0
  comments: Number,     // Default: 0
  author: String        // Required
}
```

### Ad Model

```javascript
{
  title: String,                    // Required
  content: String,
  imageUrl: String,                 // Kept for backward compatibility
  imageUrls: [String],              // New field for multiple images
  linkUrl: String,
  isActive: Boolean,                // Default: true
  createdAt: Date,                  // Default: Date.now()
  updatedAt: Date,                  // Default: Date.now()
  author: String,                   // Required
  authorId: String,                 // Required
  positionInterval: Number,         // Default: 3
  maxViewsPerDay: Number,           // Default: 3 (Intelligent ad field)
  cooldownPeriodHours: Number,      // Default: 24 (Intelligent ad field)
  frequencyControlEnabled: Boolean, // Default: true (Intelligent ad field)
  userBehaviorTrackingEnabled: Boolean // Default: true (Intelligent ad field)
}
```

## Frontend Technologies

- EJS (Embedded JavaScript templating)
- Bootstrap 5
- Font Awesome icons
- Vanilla JavaScript
- Chart.js for data visualization

## Backend Technologies

- Node.js
- Express.js
- MongoDB with Mongoose
- Socket.IO for real-time communication
- dotenv for environment variables

## Google Sign-In Configuration

For the Flutter app to work properly with Google Sign-In, you need to configure the SHA-1 fingerprint in Firebase Console. See [GOOGLE_SIGN_IN_FIX.md](../GOOGLE_SIGN_IN_FIX.md) for detailed instructions.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a pull request

## License

This project is licensed under the MIT License.