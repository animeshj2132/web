const WebSocket = require("ws");
const express = require("express");
const path = require("path");

const app = express();

// Serve static HTML files
app.use(express.static(path.join(__dirname)));

const server = app.listen(3000, () => {
  console.log("Signaling server running on http://localhost:3000");
  console.log("Open http://localhost:3000/phone.html and http://localhost:3000/doctor.html");
});

const wss = new WebSocket.Server({ server });

const users = new Map(); // userId -> socket

wss.on("connection", (ws) => {
  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    // User authentication
    if (data.type === "LOGIN") {
      users.set(data.userId, ws);
      ws.userId = data.userId;
      console.log("User connected:", data.userId);
      return;
    }

    // Send message to another user
    if (data.to) {
      const target = users.get(data.to);
      if (target) {
        console.log(`Sending ${data.type} from ${ws.userId} to ${data.to}`);
        target.send(JSON.stringify(data));
      } else {
        console.log(`Target user ${data.to} not found`);
      }
    }
  });

  ws.on("close", () => {
    if (ws.userId) users.delete(ws.userId);
  });
});
