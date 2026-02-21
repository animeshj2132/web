const WebSocket = require("ws");
const express = require("express");
const path = require("path");
const cors = require("cors");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const app = express();
app.use(cors());
app.use(express.json());

// Serve static HTML files
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});

const wss = new WebSocket.Server({ server });

const users = new Map(); // userId -> socket
const activeCalls = new Map(); // callId -> { doctor, patient, status, offer, answer, candidates }

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    connections: users.size,
    activeCalls: activeCalls.size,
    timestamp: new Date().toISOString()
  });
});

// Self-ping endpoint to keep server awake on Render
app.get('/ping', (req, res) => {
  res.json({ 
    status: 'pong', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Get active call for reconnection
app.get('/api/call/:callId', (req, res) => {
  const call = activeCalls.get(req.params.callId);
  if (call) {
    res.json({ success: true, call });
  } else {
    res.json({ success: false, error: 'Call not found' });
  }
});

wss.on("connection", (ws) => {
  console.log("New WebSocket connection");
  
  ws.on("message", (msg) => {
    try {
    const data = JSON.parse(msg);
      console.log(`Received: ${data.type} from ${data.from || data.userId || 'unknown'}`);

    // User authentication
    if (data.type === "LOGIN") {
      users.set(data.userId, ws);
      ws.userId = data.userId;
        ws.userType = data.userType;
        console.log(`User logged in: ${data.userId} (${data.userType})`);
        
        ws.send(JSON.stringify({
          type: "LOGIN_SUCCESS",
          userId: data.userId
        }));
        return;
      }

      // Handle OFFER - store call and forward
      if (data.type === "OFFER") {
        const callId = data.callId || `call_${Date.now()}`;
        
        // Store call for reconnection
        activeCalls.set(callId, {
          id: callId,
          doctor: data.from,
          patient: data.to,
          status: 'pending',
          offer: data.offer,
          callType: data.callType || 'video',
          createdAt: Date.now(),
          candidates: {
            doctor: [],
            patient: []
          }
        });
        
        console.log(`Call ${callId} created and stored`);
        
        // Forward to patient
        const target = users.get(data.to);
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify({
            ...data,
            callId
          }));
        }
        return;
      }

      // Handle ANSWER - update call and forward
      if (data.type === "ANSWER") {
        const call = activeCalls.get(data.callId);
        if (call) {
          call.answer = data.answer;
          call.status = 'connected';
          call.answeredAt = Date.now();
          console.log(`Call ${data.callId} answered and stored`);
        }
        
        // Forward to doctor
        const target = users.get(data.to);
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify(data));
        }
        return;
      }

      // Handle ICE candidates - store and forward
      if (data.type === "ICE") {
        const call = activeCalls.get(data.callId);
        if (call && data.candidate) {
          // Store ICE candidate for reconnection
          const isDoctor = data.from === call.doctor;
          const candidateList = isDoctor ? call.candidates.doctor : call.candidates.patient;
          candidateList.push(data.candidate);
          console.log(`ICE candidate stored for ${isDoctor ? 'doctor' : 'patient'} in call ${data.callId}`);
        }
        
        // Forward to other party
        const target = users.get(data.to);
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify(data));
        }
        return;
      }

      // Handle reconnection - send stored call data
      if (data.type === "RECONNECT") {
        const call = activeCalls.get(data.callId);
        if (call) {
          console.log(`User ${data.userId} reconnecting to call ${data.callId}`);
          
          const isDoctor = data.userId === call.doctor;
          
          ws.send(JSON.stringify({
            type: "RECONNECT_DATA",
            callId: data.callId,
            call: {
              offer: call.offer,
              answer: call.answer,
              status: call.status,
              callType: call.callType,
              // Send ICE candidates from other party
              candidates: isDoctor ? call.candidates.patient : call.candidates.doctor
            }
          }));
        } else {
          ws.send(JSON.stringify({
            type: "RECONNECT_FAILED",
            callId: data.callId,
            error: "Call not found"
          }));
        }
        return;
      }

      // Handle explicit END_CALL only
      if (data.type === "END_CALL") {
        const call = activeCalls.get(data.callId);
        if (call) {
          call.status = 'ended';
          call.endedAt = Date.now();
          console.log(`Call ${data.callId} ended by user`);
          
          // Notify other party
          const otherPartyId = data.from === call.doctor ? call.patient : call.doctor;
          const otherParty = users.get(otherPartyId);
          if (otherParty && otherParty.readyState === WebSocket.OPEN) {
            otherParty.send(JSON.stringify({
              type: "CALL_ENDED",
              callId: data.callId,
              endedBy: data.from
            }));
          }
          
          // Delete call after notifying
          setTimeout(() => activeCalls.delete(data.callId), 5000);
        }
        return;
      }

      // Handle DECLINE_CALL
      if (data.type === "DECLINE_CALL") {
        const call = activeCalls.get(data.callId);
        if (call) {
          call.status = 'declined';
          activeCalls.delete(data.callId);
        }
        
        // Forward to doctor
        const target = users.get(data.to);
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify(data));
        }
      return;
    }

      // Forward any other message
    if (data.to) {
      const target = users.get(data.to);
        if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify(data));
      } else {
          console.log(`Target user ${data.to} not found or not connected`);
        }
      }
    } catch (error) {
      console.error("Error processing message:", error);
    }
  });

  ws.on("close", () => {
    if (ws.userId) {
      console.log(`User disconnected: ${ws.userId}`);
      users.delete(ws.userId);
      // Note: Don't delete active calls on disconnect - allow reconnection
    }
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

// Cleanup old calls (older than 1 hour)
setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  
  activeCalls.forEach((call, callId) => {
    if (now - call.createdAt > oneHour) {
      console.log(`Cleaning up old call: ${callId}`);
      activeCalls.delete(callId);
    }
  });
}, 5 * 60 * 1000); // Check every 5 minutes

// Self-ping every 30 seconds to keep Render server awake
// Render free tier services sleep after 15 minutes of inactivity
const getServerURL = () => {
  // Use the deployed Render URL (hardcoded since we know it)
  if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
    return 'https://web-m4g9.onrender.com';
  }
  // Local development
  return `http://localhost:${PORT}`;
};

const SERVER_URL = getServerURL();

// Self-ping function using Node.js http/https (better compatibility)
const performSelfPing = () => {
  try {
    const parsedUrl = new URL(`${SERVER_URL}/ping`);
    const client = parsedUrl.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname,
      method: 'GET',
      headers: {
        'User-Agent': 'WebRTC-Server-SelfPing/1.0',
        'Connection': 'keep-alive'
      },
      timeout: 5000
    };
    
    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            console.log(`✅ Self-ping successful: ${json.timestamp} (uptime: ${Math.floor(json.uptime)}s)`);
          } catch (e) {
            console.log(`✅ Self-ping successful: ${res.statusCode}`);
          }
        } else {
          console.warn(`⚠️ Self-ping returned status: ${res.statusCode}`);
        }
      });
    });
    
    req.on('error', (error) => {
      console.error(`❌ Self-ping failed:`, error.message);
    });
    
    req.on('timeout', () => {
      req.destroy();
      console.error(`❌ Self-ping timeout`);
    });
    
    req.end();
  } catch (error) {
    console.error(`❌ Self-ping error:`, error.message);
  }
};

// Start self-ping after 5 seconds (give server time to start)
setTimeout(() => {
  console.log(`🔄 Starting self-ping to: ${SERVER_URL}/ping`);
  performSelfPing();
}, 5000);

// Then ping every 30 seconds
setInterval(performSelfPing, 30 * 1000);

console.log("WebRTC Signaling Server initialized");
console.log(`🔄 Self-ping enabled: ${SERVER_URL}/ping (every 30 seconds)`);