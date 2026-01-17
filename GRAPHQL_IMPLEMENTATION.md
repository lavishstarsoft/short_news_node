# GraphQL API Implementation - Short News

## Overview
GraphQL API has been successfully implemented in both backend (Node.js) and frontend (Flutter).

## Backend Setup ✅

### Dependencies Installed
- `apollo-server-express` - GraphQL server for Express
- `graphql` - GraphQL implementation

### Files Created
1. **`graphql/schema.js`** - GraphQL schema definitions
   - Types: News, Category, Location, User, ViralVideo, Comment
   - Queries: news, categories, locations, viralVideos, etc.
   - Mutations: likeNews, dislikeNews, addComment, etc.

2. **`graphql/resolvers.js`** - GraphQL resolvers
   - Implements all queries and mutations
   - Connects to MongoDB models
   - Includes error handling

3. **`server.js`** - Updated to include Apollo Server
   - GraphQL endpoint: `/graphql`
   - GraphQL Playground enabled for testing

### GraphQL Endpoint
- **URL**: `http://localhost:3001/graphql`
- **Playground**: `http://localhost:3001/graphql` (browser)

## Frontend Setup ✅

### Dependencies Installed
- `graphql_flutter` - GraphQL client for Flutter

### Files Created/Modified
1. **`lib/services/graphql_service.dart`** - GraphQL service
   - Configured for Android emulator: `http://10.0.2.2:3001/graphql`
   - Methods for all queries and mutations

2. **`lib/screens/home_screen.dart`** - Migrated to GraphQL
   - Replaced REST API calls with GraphQL
   - Uses `GraphQLService.getNews()`
   - Uses GraphQL mutations for likes, dislikes, comments

## Testing the GraphQL API

### 1. Using GraphQL Playground (Browser)
Visit: `http://localhost:3001/graphql`

**Example Query - Fetch News:**
```graphql
query {
  news(limit: 10) {
    id
    title
    content
    category
    location
    likes
    dislikes
    views
    publishedAt
  }
}
```

**Example Query - Fetch Categories:**
```graphql
query {
  categories {
    id
    name
    description
  }
}
```

**Example Mutation - Like News:**
```graphql
mutation {
  likeNews(newsId: "YOUR_NEWS_ID") {
    id
    likes
    dislikes
  }
}
```

**Example Query - Fetch News by Location:**
```graphql
query {
  news(limit: 10, location: "Hyderabad") {
    id
    title
    location
  }
}
```

### 2. Testing from Flutter App
The Flutter app is configured to use GraphQL automatically. Just run the app and:
- News feed will load using GraphQL
- Like/Dislike actions use GraphQL mutations
- Comments use GraphQL mutations

### 3. Using cURL (Command Line)
```bash
curl -X POST http://localhost:3001/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ news(limit: 5) { id title } }"}'
```

## Available GraphQL Operations

### Queries
- `news(limit, offset, category, location)` - Fetch news with filters
- `newsById(id)` - Fetch single news item
- `categories` - Fetch all categories
- `locations` - Fetch all locations
- `viralVideos(limit, offset)` - Fetch viral videos
- `user(id)` - Fetch user by ID

### Mutations
- `likeNews(newsId)` - Like a news item
- `dislikeNews(newsId)` - Dislike a news item
- `addComment(newsId, text)` - Add comment to news
- `incrementViews(newsId)` - Increment view count
- `likeViralVideo(videoId)` - Like a viral video
- `dislikeViralVideo(videoId)` - Dislike a viral video

## Migration Status

### ✅ Completed
- Backend GraphQL server setup
- GraphQL schema and resolvers
- Frontend GraphQL service
- Home screen migrated to GraphQL
- News interactions (like, dislike, comment) using GraphQL

### 🔄 Pending Migration
The following files still use REST API and need to be migrated:
1. `viral_videos_screen.dart` - Viral videos
2. `profilepage.dart` - User profile
3. `news_card.dart` - Some utility methods
4. `comment_service.dart` - Comment interactions
5. `ad_api_service.dart` - Ad service

## Configuration

### Backend
- GraphQL endpoint: `/graphql`
- CORS enabled for Flutter app origins
- Introspection and Playground enabled

### Frontend
- **Android Emulator**: `http://10.0.2.2:3001/graphql`
- **iOS Simulator**: `http://localhost:3001/graphql`
- **Physical Device**: Use your computer's IP address

## Benefits of GraphQL

1. **Efficient Data Fetching** - Request only the data you need
2. **Single Endpoint** - All operations through `/graphql`
3. **Type Safety** - Strongly typed schema
4. **Real-time Updates** - Can be extended with subscriptions
5. **Better Performance** - Reduced over-fetching and under-fetching
6. **Self-documenting** - GraphQL Playground provides interactive documentation

## Next Steps

1. Test the GraphQL endpoint using Playground
2. Migrate remaining screens to use GraphQL
3. Add authentication to GraphQL mutations
4. Implement GraphQL subscriptions for real-time updates
5. Add caching strategies for better performance

## Troubleshooting

### GraphQL endpoint not accessible
- Ensure the backend server is running: `npm run dev`
- Check if MongoDB is connected
- Verify port 3001 is not blocked

### Flutter app can't connect
- For Android emulator, use `10.0.2.2` instead of `localhost`
- For iOS simulator, use `localhost`
- For physical device, use your computer's IP address
- Ensure both devices are on the same network

### GraphQL errors
- Check the GraphQL Playground for detailed error messages
- Verify the schema matches your database models
- Check MongoDB connection status
