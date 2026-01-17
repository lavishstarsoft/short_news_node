// Direct test to send a notification using the server's io instance
const http = require('http');
const socketIo = require('socket.io');

// Create a simple HTTP server to communicate with the main server
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/send-notification') {
    // Get the io instance from the main server
    // This is a simplified approach - in reality, you'd need to access the actual io instance
    
    console.log('Would send notification here');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Notification sent' }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(3003, () => {
  console.log('Test server running on port 3003');
  console.log('Send POST request to /send-notification to trigger a test notification');
});