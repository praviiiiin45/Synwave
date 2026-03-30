import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

const JWT_SECRET = process.env.JWT_SECRET || "syncwave-secret-key";

async function startServer() {
  const app = express();
  app.use(express.json());
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    maxHttpBufferSize: 1e8, // 100MB for audio files
    cors: {
      origin: "*",
    },
  });

  const PORT = 3000;

  // Mock database
  const users: any[] = [];
  const rooms: Record<string, {
    hostId: string;
    hostEmail: string;
    queue: { audioData: Buffer, fileName: string, id: string }[];
    currentTrackIndex: number;
    isPlaying: boolean;
    serverStartTime: number;
    seekTime: number;
    participants: { socketId: string, username: string }[];
    messages: { username: string, text: string, timestamp: number }[];
  }> = {};

  // Auth Endpoints
  app.post("/api/signup", async (req, res) => {
    const { email, password } = req.body;
    if (users.find(u => u.email === email)) {
      return res.status(400).json({ error: "User already exists" });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = { email, password: hashedPassword };
    users.push(user);
    const token = jwt.sign({ email }, JWT_SECRET);
    res.json({ token, email });
  });

  app.post("/api/login", async (req, res) => {
    const { email, password } = req.body;
    const user = users.find(u => u.email === email);
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = jwt.sign({ email }, JWT_SECRET);
    res.json({ token, email });
  });

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join-room", ({ roomId, username, token }: { roomId: string, username: string, token?: string }) => {
      let email = "";
      if (token) {
        try {
          const decoded = jwt.verify(token, JWT_SECRET) as { email: string };
          email = decoded.email;
        } catch (e) {}
      }

      socket.join(roomId);
      
      if (!rooms[roomId]) {
        rooms[roomId] = {
          hostId: socket.id,
          hostEmail: email,
          queue: [],
          currentTrackIndex: -1,
          isPlaying: false,
          serverStartTime: 0,
          seekTime: 0,
          participants: [],
          messages: [],
        };
      }

      rooms[roomId].participants.push({ socketId: socket.id, username });
      
      // Send current state
      socket.emit("room-state", {
        hostId: rooms[roomId].hostId,
        queue: rooms[roomId].queue.map(t => ({ fileName: t.fileName, id: t.id })),
        currentTrackIndex: rooms[roomId].currentTrackIndex,
        currentTrackData: rooms[roomId].currentTrackIndex >= 0 ? rooms[roomId].queue[rooms[roomId].currentTrackIndex].audioData : null,
        isPlaying: rooms[roomId].isPlaying,
        serverStartTime: rooms[roomId].serverStartTime,
        seekTime: rooms[roomId].seekTime,
        participants: rooms[roomId].participants.map(p => p.username),
        messages: rooms[roomId].messages,
      });

      io.to(roomId).emit("user-joined", { 
        username, 
        participants: rooms[roomId].participants.map(p => p.username) 
      });
    });

    socket.on("add-to-queue", ({ roomId, audioData, fileName }: { roomId: string, audioData: Buffer, fileName: string }) => {
      if (rooms[roomId] && rooms[roomId].hostId === socket.id) {
        const trackId = Math.random().toString(36).substring(7);
        const newTrack = { audioData, fileName, id: trackId };
        rooms[roomId].queue.push(newTrack);
        
        // If no track is playing, start this one
        if (rooms[roomId].currentTrackIndex === -1) {
          rooms[roomId].currentTrackIndex = 0;
          rooms[roomId].isPlaying = false;
          rooms[roomId].seekTime = 0;
          io.to(roomId).emit("track-change", { 
            index: 0, 
            audioData, 
            fileName,
            queue: rooms[roomId].queue.map(t => ({ fileName: t.fileName, id: t.id }))
          });
        } else {
          io.to(roomId).emit("queue-updated", { 
            queue: rooms[roomId].queue.map(t => ({ fileName: t.fileName, id: t.id })) 
          });
        }
      }
    });

    socket.on("next-track", ({ roomId }: { roomId: string }) => {
      if (rooms[roomId] && rooms[roomId].hostId === socket.id) {
        const nextIndex = rooms[roomId].currentTrackIndex + 1;
        if (nextIndex < rooms[roomId].queue.length) {
          rooms[roomId].currentTrackIndex = nextIndex;
          rooms[roomId].isPlaying = true;
          rooms[roomId].serverStartTime = Date.now();
          rooms[roomId].seekTime = 0;
          
          const track = rooms[roomId].queue[nextIndex];
          io.to(roomId).emit("track-change", { 
            index: nextIndex, 
            audioData: track.audioData, 
            fileName: track.fileName,
            queue: rooms[roomId].queue.map(t => ({ fileName: t.fileName, id: t.id }))
          });
          io.to(roomId).emit("sync-play", { serverStartTime: rooms[roomId].serverStartTime, seekTime: 0 });
        } else {
          rooms[roomId].isPlaying = false;
          io.to(roomId).emit("sync-pause", { seekTime: 0 });
        }
      }
    });

    socket.on("send-message", ({ roomId, username, text }: { roomId: string, username: string, text: string }) => {
      if (rooms[roomId]) {
        const message = { username, text, timestamp: Date.now() };
        rooms[roomId].messages.push(message);
        io.to(roomId).emit("new-message", message);
      }
    });

    socket.on("sync-play", ({ roomId, seekTime }: { roomId: string, seekTime: number }) => {
      if (rooms[roomId] && rooms[roomId].hostId === socket.id) {
        rooms[roomId].isPlaying = true;
        rooms[roomId].serverStartTime = Date.now();
        rooms[roomId].seekTime = seekTime;
        io.to(roomId).emit("sync-play", {
          serverStartTime: rooms[roomId].serverStartTime,
          seekTime: rooms[roomId].seekTime,
        });
      }
    });

    socket.on("sync-pause", ({ roomId, seekTime }: { roomId: string, seekTime: number }) => {
      if (rooms[roomId] && rooms[roomId].hostId === socket.id) {
        rooms[roomId].isPlaying = false;
        rooms[roomId].seekTime = seekTime;
        io.to(roomId).emit("sync-pause", { seekTime });
      }
    });

    socket.on("sync-seek", ({ roomId, seekTime }: { roomId: string, seekTime: number }) => {
      if (rooms[roomId] && rooms[roomId].hostId === socket.id) {
        rooms[roomId].seekTime = seekTime;
        rooms[roomId].serverStartTime = Date.now();
        io.to(roomId).emit("sync-seek", {
          seekTime: rooms[roomId].seekTime,
          serverStartTime: rooms[roomId].serverStartTime,
          isPlaying: rooms[roomId].isPlaying
        });
      }
    });

    socket.on("request-time", (callback) => {
      callback(Date.now());
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      // Cleanup logic could go here
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
