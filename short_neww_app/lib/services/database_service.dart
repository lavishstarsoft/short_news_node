import 'package:sqflite/sqflite.dart';
import 'package:path/path.dart';
import '../models/news_model.dart';

class DatabaseService {
  static Database? _database;
  
  // Get database instance
  static Future<Database> get database async {
    if (_database != null) return _database!;
    _database = await _initDB();
    return _database!;
  }
  
  // Initialize database
  static Future<Database> _initDB() async {
    final dbPath = await getDatabasesPath();
    final path = join(dbPath, 'short_news.db');
    
    return await openDatabase(
      path,
      version: 1,
      onCreate: (db, version) async {
        // Create table for all news
        await db.execute('''
          CREATE TABLE all_news(
            id TEXT PRIMARY KEY,
            title TEXT,
            content TEXT,
            imageUrl TEXT,
            mediaUrl TEXT,
            mediaType TEXT,
            category TEXT,
            location TEXT,
            publishedAt TEXT,
            likes INTEGER,
            dislikes INTEGER,
            comments INTEGER,
            author TEXT,
            isRead INTEGER
          )
        ''');
        
        // Create table for read news with timestamp
        await db.execute('''
          CREATE TABLE read_news(
            id TEXT PRIMARY KEY,
            readAt TEXT
          )
        ''');
      },
    );
  }
  
  // Insert or update all news in the database
  static Future<void> saveAllNews(List<NewsModel> newsList) async {
    final db = await database;
    
    // Use batch for better performance
    final batch = db.batch();
    
    for (final news in newsList) {
      batch.insert(
        'all_news',
        {
          'id': news.id,
          'title': news.title,
          'content': news.content,
          'imageUrl': news.imageUrl,
          'mediaUrl': news.mediaUrl,
          'mediaType': news.mediaType,
          'category': news.category,
          'location': news.location,
          'publishedAt': news.publishedAt.toIso8601String(),
          'likes': news.likes,
          'dislikes': news.dislikes,
          'comments': news.comments,
          'author': news.author,
          'isRead': news.isRead ? 1 : 0,
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
    }
    
    await batch.commit(noResult: true);
  }
  
  // Mark a news item as read
  static Future<void> markNewsAsRead(String newsId) async {
    final db = await database;
    
    // Insert or replace in read_news table
    await db.insert(
      'read_news',
      {
        'id': newsId,
        'readAt': DateTime.now().toIso8601String(),
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }
  
  // Check if a news item is read
  static Future<bool> isNewsRead(String newsId) async {
    final db = await database;
    
    final List<Map<String, dynamic>> result = await db.query(
      'read_news',
      where: 'id = ?',
      whereArgs: [newsId],
    );
    
    return result.isNotEmpty;
  }
  
  // Mark all news as read
  static Future<void> markAllNewsAsRead(List<String> newsIds) async {
    final db = await database;
    final batch = db.batch();
    final now = DateTime.now().toIso8601String();
    
    for (final id in newsIds) {
      batch.insert(
        'read_news',
        {
          'id': id,
          'readAt': now,
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
    }
    
    await batch.commit(noResult: true);
  }
  
  // Get unread news count from last 24 hours
  static Future<int> getUnreadNewsCount() async {
    final db = await database;
    
    // Calculate 24 hours ago
    final twentyFourHoursAgo = DateTime.now().subtract(Duration(hours: 24)).toIso8601String();
    
    // Query to get unread news from last 24 hours
    final List<Map<String, dynamic>> result = await db.rawQuery('''
      SELECT COUNT(*) as count
      FROM all_news a
      LEFT JOIN read_news r ON a.id = r.id
      WHERE a.publishedAt > ? AND r.id IS NULL
    ''', [twentyFourHoursAgo]);
    
    return result.first['count'] as int;
  }
  
  // Get all news from database
  static Future<List<NewsModel>> getAllNews() async {
    final db = await database;
    final List<Map<String, dynamic>> maps = await db.query('all_news');
    
    return List.generate(maps.length, (i) {
      return NewsModel.fromJson({
        'id': maps[i]['id'],
        'title': maps[i]['title'],
        'content': maps[i]['content'],
        'imageUrl': maps[i]['imageUrl'],
        'mediaUrl': maps[i]['mediaUrl'],
        'mediaType': maps[i]['mediaType'],
        'category': maps[i]['category'],
        'location': maps[i]['location'],
        'publishedAt': maps[i]['publishedAt'],
        'likes': maps[i]['likes'],
        'dislikes': maps[i]['dislikes'],
        'comments': maps[i]['comments'],
        'author': maps[i]['author'],
        'isRead': maps[i]['isRead'] == 1,
      });
    });
  }
  
  // Reset read status for all news
  static Future<void> resetReadStatus() async {
    final db = await database;
    await db.delete('read_news');
  }
  
  // Close database
  static Future<void> close() async {
    final db = await database;
    await db.close();
    _database = null;
  }
}