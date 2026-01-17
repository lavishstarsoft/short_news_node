#!/bin/bash

# Get the current IP address
IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | head -1 | awk '{print $2}')

echo "Starting Short News Admin Server..."
echo "Network IP: $IP"
echo "Server will be accessible at:"
echo "  - Local: http://localhost:3001"
echo "  - Network: http://$IP:3001"
echo "  - API: http://$IP:3001/api/public/news"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

# Start the server
npm start
