import 'package:graphql_flutter/graphql_flutter.dart';

class GraphQLService {
  // Update this URL to match your backend server
  // For Android emulator: use 10.0.2.2
  // For iOS simulator: use localhost
  // For physical device: use your computer's IP address
  static final HttpLink _httpLink = HttpLink(
    'https://shortnews-production.up.railway.app/graphql', // Android emulator
    // 'http://localhost:3001/graphql', // iOS simulator
    // 'http://YOUR_IP:3001/graphql', // Physical device
  );

  static final GraphQLClient _client = GraphQLClient(
    link: _httpLink,
    cache: GraphQLCache(store: InMemoryStore()),
  );

  static GraphQLClient get client => _client;

  // ==================== CACHE MANAGEMENT ====================

  /// Clear GraphQL cache to force fresh data fetch
  static Future<void> clearCache() async {
    try {
      _client.cache.store.reset();
      print('✅ GraphQL cache cleared');
    } catch (e) {
      print('⚠️ Error clearing GraphQL cache: $e');
    }
  }

  /// Refetch news with cache bypass (force network request)
  static Future<List<dynamic>> refetchNews({
    int? limit,
    int? offset,
    String? category,
    String? location,
  }) async {
    // Clear cache first
    await clearCache();
    // Then fetch fresh data
    return getNews(
      limit: limit,
      offset: offset,
      category: category,
      location: location,
    );
  }

  // ==================== NEWS QUERIES ====================

  /// Fetch news with optional filters
  static Future<List<dynamic>> getNews({
    int? limit,
    int? offset,
    String? category,
    String? location,
  }) async {
    const String query = r'''
      query GetNews($limit: Int, $offset: Int, $category: String, $location: String) {
        news(limit: $limit, offset: $offset, category: $category, location: $location) {
          id
          title
          content
          imageUrl
          videoUrl
          mediaUrl
          mediaType
          thumbnailUrl
          category
          location
          publishedAt
          likes
          dislikes
          views
          comments
          author
          readFullLink
          ePaperLink
        }
      }
    ''';

    try {
      final QueryOptions options = QueryOptions(
        document: gql(query),
        variables: {
          if (limit != null) 'limit': limit,
          if (offset != null) 'offset': offset,
          if (category != null) 'category': category,
          if (location != null) 'location': location,
        },
      );

      print('GraphQL: Fetching news with variables: ${options.variables}');
      final QueryResult result = await _client.query(options);

      if (result.hasException) {
        print('GraphQL Exception: ${result.exception}');
        if (result.exception?.linkException != null) {
          print('Link Exception: ${result.exception?.linkException}');
        }
        if (result.exception?.graphqlErrors != null) {
          print('GraphQL Errors: ${result.exception?.graphqlErrors}');
        }
        throw Exception('GraphQL Error: ${result.exception.toString()}');
      }

      print(
        'GraphQL: Successfully fetched ${(result.data?['news'] as List?)?.length ?? 0} news items',
      );
      return result.data?['news'] ?? [];
    } catch (e) {
      print('Error fetching news: $e');
      rethrow;
    }
  }

  /// Fetch a single news item by ID
  static Future<Map<String, dynamic>?> getNewsById(String id) async {
    const String query = r'''
      query GetNewsById($id: ID!) {
        newsById(id: $id) {
          id
          title
          content
          imageUrl
          videoUrl
          mediaUrl
          mediaType
          thumbnailUrl
          category
          location
          publishedAt
          likes
          dislikes
          views
          comments
          author
          readFullLink
          ePaperLink
        }
      }
    ''';

    try {
      final QueryOptions options = QueryOptions(
        document: gql(query),
        variables: {'id': id},
      );

      final QueryResult result = await _client.query(options);

      if (result.hasException) {
        throw Exception('GraphQL Error: ${result.exception.toString()}');
      }

      return result.data?['newsById'];
    } catch (e) {
      print('Error fetching news by ID: $e');
      rethrow;
    }
  }

  // ==================== CATEGORY QUERIES ====================

  /// Fetch all categories
  static Future<List<dynamic>> getCategories() async {
    const String query = r'''
      query GetCategories {
        categories {
          id
          name
          description
        }
      }
    ''';

    try {
      final QueryOptions options = QueryOptions(document: gql(query));

      final QueryResult result = await _client.query(options);

      if (result.hasException) {
        throw Exception('GraphQL Error: ${result.exception.toString()}');
      }

      return result.data?['categories'] ?? [];
    } catch (e) {
      print('Error fetching categories: $e');
      rethrow;
    }
  }

  // ==================== LOCATION QUERIES ====================

  /// Fetch all locations
  static Future<List<dynamic>> getLocations() async {
    const String query = r'''
      query GetLocations {
        locations {
          id
          name
          description
        }
      }
    ''';

    try {
      final QueryOptions options = QueryOptions(document: gql(query));

      final QueryResult result = await _client.query(options);

      if (result.hasException) {
        throw Exception('GraphQL Error: ${result.exception.toString()}');
      }

      return result.data?['locations'] ?? [];
    } catch (e) {
      print('Error fetching locations: $e');
      rethrow;
    }
  }

  // ==================== VIRAL VIDEOS QUERIES ====================

  /// Fetch viral videos
  static Future<List<dynamic>> getViralVideos({int? limit, int? offset}) async {
    const String query = r'''
      query GetViralVideos($limit: Int, $offset: Int) {
        viralVideos(limit: $limit, offset: $offset) {
          id
          title
          description
          videoUrl
          thumbnailUrl
          views
          likes
          dislikes
          createdAt
        }
      }
    ''';

    try {
      final QueryOptions options = QueryOptions(
        document: gql(query),
        variables: {
          if (limit != null) 'limit': limit,
          if (offset != null) 'offset': offset,
        },
      );

      final QueryResult result = await _client.query(options);

      if (result.hasException) {
        throw Exception('GraphQL Error: ${result.exception.toString()}');
      }

      return result.data?['viralVideos'] ?? [];
    } catch (e) {
      print('Error fetching viral videos: $e');
      rethrow;
    }
  }

  // ==================== NEWS MUTATIONS ====================

  /// Like a news item
  static Future<Map<String, dynamic>?> likeNews(String newsId) async {
    const String mutation = r'''
      mutation LikeNews($newsId: ID!) {
        likeNews(newsId: $newsId) {
          id
          likes
          dislikes
        }
      }
    ''';

    try {
      final MutationOptions options = MutationOptions(
        document: gql(mutation),
        variables: {'newsId': newsId},
      );

      final QueryResult result = await _client.mutate(options);

      if (result.hasException) {
        throw Exception('GraphQL Error: ${result.exception.toString()}');
      }

      return result.data?['likeNews'];
    } catch (e) {
      print('Error liking news: $e');
      rethrow;
    }
  }

  /// Dislike a news item
  static Future<Map<String, dynamic>?> dislikeNews(String newsId) async {
    const String mutation = r'''
      mutation DislikeNews($newsId: ID!) {
        dislikeNews(newsId: $newsId) {
          id
          likes
          dislikes
        }
      }
    ''';

    try {
      final MutationOptions options = MutationOptions(
        document: gql(mutation),
        variables: {'newsId': newsId},
      );

      final QueryResult result = await _client.mutate(options);

      if (result.hasException) {
        throw Exception('GraphQL Error: ${result.exception.toString()}');
      }

      return result.data?['dislikeNews'];
    } catch (e) {
      print('Error disliking news: $e');
      rethrow;
    }
  }

  /// Add a comment to a news item
  static Future<Map<String, dynamic>?> addComment(
    String newsId,
    String text,
  ) async {
    const String mutation = r'''
      mutation AddComment($newsId: ID!, $text: String!) {
        addComment(newsId: $newsId, text: $text) {
          id
          comments
        }
      }
    ''';

    try {
      final MutationOptions options = MutationOptions(
        document: gql(mutation),
        variables: {'newsId': newsId, 'text': text},
      );

      final QueryResult result = await _client.mutate(options);

      if (result.hasException) {
        throw Exception('GraphQL Error: ${result.exception.toString()}');
      }

      return result.data?['addComment'];
    } catch (e) {
      print('Error adding comment: $e');
      rethrow;
    }
  }

  // ==================== COMBINED QUERIES ====================

  /// Fetch home screen data (news, categories, locations) in a single request
  static Future<Map<String, dynamic>> getHomeScreenData({
    int? newsLimit,
    String? category,
    String? location,
  }) async {
    const String query = r'''
      query GetHomeScreenData($newsLimit: Int, $category: String, $location: String) {
        news(limit: $newsLimit, category: $category, location: $location) {
          id
          title
          content
          imageUrl
          videoUrl
          mediaUrl
          mediaType
          thumbnailUrl
          category
          location
          publishedAt
          likes
          dislikes
          views
          comments
          author
          readFullLink
          ePaperLink
        }
        categories {
          id
          name
          description
        }
        locations {
          id
          name
          description
        }
      }
    ''';

    try {
      final QueryOptions options = QueryOptions(
        document: gql(query),
        variables: {
          if (newsLimit != null) 'newsLimit': newsLimit,
          if (category != null) 'category': category,
          if (location != null) 'location': location,
        },
      );

      final QueryResult result = await _client.query(options);

      if (result.hasException) {
        throw Exception('GraphQL Error: ${result.exception.toString()}');
      }

      return {
        'news': result.data?['news'] ?? [],
        'categories': result.data?['categories'] ?? [],
        'locations': result.data?['locations'] ?? [],
      };
    } catch (e) {
      print('Error fetching home screen data: $e');
      rethrow;
    }
  }
}
