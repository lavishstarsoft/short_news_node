import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

void main() {
  runApp(const TitleColorTestApp());
}

class TitleColorTestApp extends StatelessWidget {
  const TitleColorTestApp({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Title Color Test',
      home: TitleColorTestScreen(),
    );
  }
}

class TitleColorTestScreen extends StatefulWidget {
  @override
  _TitleColorTestScreenState createState() => _TitleColorTestScreenState();
}

class _TitleColorTestScreenState extends State<TitleColorTestScreen> {
  final FlutterLocalNotificationsPlugin _notifications = FlutterLocalNotificationsPlugin();

  @override
  void initState() {
    super.initState();
    _initializeNotifications();
  }

  Future<void> _initializeNotifications() async {
    const AndroidInitializationSettings initializationSettingsAndroid =
        AndroidInitializationSettings('@mipmap/ic_launcher');
        
    final InitializationSettings initializationSettings = const InitializationSettings(
      android: initializationSettingsAndroid,
    );

    await _notifications.initialize(initializationSettings);
  }

  Future<void> _showNotificationWithoutColor() async {
    const AndroidNotificationDetails androidPlatformChannelSpecifics =
        AndroidNotificationDetails(
      'test_channel',
      'Test Channel',
      channelDescription: 'Test channel for title color',
      importance: Importance.max,
      priority: Priority.high,
    );
    const NotificationDetails platformChannelSpecifics =
        NotificationDetails(android: androidPlatformChannelSpecifics);
    await _notifications.show(
      0,
      'Test Notification - No Color',
      'This notification should use the default title color',
      platformChannelSpecifics,
    );
  }

  Future<void> _showNotificationWithRedColor() async {
    final AndroidNotificationDetails androidPlatformChannelSpecifics =
        AndroidNotificationDetails(
      'test_channel',
      'Test Channel',
      channelDescription: 'Test channel for title color',
      importance: Importance.max,
      priority: Priority.high,
      color: Colors.red,
      ledColor: Colors.red,
      enableLights: true,
    );
    final NotificationDetails platformChannelSpecifics =
        NotificationDetails(android: androidPlatformChannelSpecifics);
    await _notifications.show(
      1,
      'Test Notification - Red Color',
      'This notification should have a red title/accent',
      platformChannelSpecifics,
    );
  }

  Future<void> _showNotificationWithBlueColor() async {
    final AndroidNotificationDetails androidPlatformChannelSpecifics =
        AndroidNotificationDetails(
      'test_channel',
      'Test Channel',
      channelDescription: 'Test channel for title color',
      importance: Importance.max,
      priority: Priority.high,
      color: Colors.blue,
      ledColor: Colors.blue,
      enableLights: true,
    );
    final NotificationDetails platformChannelSpecifics =
        NotificationDetails(android: androidPlatformChannelSpecifics);
    await _notifications.show(
      2,
      'Test Notification - Blue Color',
      'This notification should have a blue title/accent',
      platformChannelSpecifics,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Title Color Test'),
      ),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            ElevatedButton(
              onPressed: _showNotificationWithoutColor,
              child: const Text('Show Notification Without Color'),
            ),
            const SizedBox(height: 20),
            ElevatedButton(
              onPressed: _showNotificationWithRedColor,
              child: const Text('Show Notification With Red Color'),
            ),
            const SizedBox(height: 20),
            ElevatedButton(
              onPressed: _showNotificationWithBlueColor,
              child: const Text('Show Notification With Blue Color'),
            ),
          ],
        ),
      ),
    );
  }
}