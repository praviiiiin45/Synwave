/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { 
  Play, 
  Pause, 
  SkipBack, 
  SkipForward, 
  Upload, 
  Users, 
  Music, 
  RefreshCw,
  Plus,
  LogIn,
  Volume2,
  Send,
  MessageSquare,
  ListMusic,
  UserPlus
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface Message {
  username: string;
  text: string;
  timestamp: number;
}

interface QueueItem {
  fileName: string;
  id: string;
}

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [roomId, setRoomId] = useState('');
  const [username, setUsername] = useState('');
  const [joined, setJoined] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [participants, setParticipants] = useState<string[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [currentTrackIndex, setCurrentTrackIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [serverOffset, setServerOffset] = useState(0);
  const [needsInteraction, setNeedsInteraction] = useState(true);
  
  // Auth State
  const [isAuthMode, setIsAuthMode] = useState(false);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [userEmail, setUserEmail] = useState(localStorage.getItem('userEmail') || '');

  // Chat State
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageInput, setMessageInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Initialize Socket
  useEffect(() => {
    const newSocket = io();
    setSocket(newSocket);

    const syncClock = async () => {
      const start = Date.now();
      newSocket.emit('request-time', (serverTime: number) => {
        const end = Date.now();
        const latency = (end - start) / 2;
        const offset = serverTime - (end - latency);
        setServerOffset(offset);
      });
    };

    const interval = setInterval(syncClock, 30000);
    syncClock();

    return () => {
      clearInterval(interval);
      newSocket.close();
    };
  }, []);

  // Socket Listeners
  useEffect(() => {
    if (!socket) return;

    socket.on('room-state', (state) => {
      setIsHost(state.hostId === socket.id);
      setParticipants(state.participants);
      setQueue(state.queue);
      setCurrentTrackIndex(state.currentTrackIndex);
      setMessages(state.messages);
      
      if (state.currentTrackData) {
        const blob = new Blob([state.currentTrackData], { type: 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        if (audioRef.current) {
          audioRef.current.src = url;
          audioRef.current.load();
        }
      }

      if (state.isPlaying) {
        handleSyncPlay(state.serverStartTime, state.seekTime);
      } else {
        handleSyncPause(state.seekTime);
      }
    });

    socket.on('queue-updated', ({ queue }) => {
      setQueue(queue);
    });

    socket.on('track-change', ({ index, audioData, fileName, queue }) => {
      setCurrentTrackIndex(index);
      setQueue(queue);
      const blob = new Blob([audioData], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      if (audioRef.current) {
        audioRef.current.src = url;
        audioRef.current.load();
        setCurrentTime(0);
      }
    });

    const handleSyncPlay = (serverStartTime: number, seekTime: number) => {
      if (!audioRef.current) return;
      const now = Date.now() + serverOffset;
      const elapsed = (now - serverStartTime) / 1000;
      const targetTime = seekTime + elapsed;
      audioRef.current.currentTime = targetTime;
      audioRef.current.play().catch(() => setNeedsInteraction(true));
      setIsPlaying(true);
    };

    const handleSyncPause = (seekTime: number) => {
      if (!audioRef.current) return;
      audioRef.current.pause();
      audioRef.current.currentTime = seekTime;
      setIsPlaying(false);
    };

    socket.on('sync-play', ({ serverStartTime, seekTime }) => {
      handleSyncPlay(serverStartTime, seekTime);
    });

    socket.on('sync-pause', ({ seekTime }) => {
      handleSyncPause(seekTime);
    });

    socket.on('sync-seek', ({ seekTime, serverStartTime, isPlaying }) => {
      if (!audioRef.current) return;
      if (isPlaying) {
        handleSyncPlay(serverStartTime, seekTime);
      } else {
        audioRef.current.currentTime = seekTime;
      }
    });

    socket.on('user-joined', ({ username, participants }) => {
      setParticipants(participants);
    });

    socket.on('new-message', (msg) => {
      setMessages(prev => [...prev, msg]);
    });

    return () => {
      socket.off('room-state');
      socket.off('queue-updated');
      socket.off('track-change');
      socket.off('sync-play');
      socket.off('sync-pause');
      socket.off('sync-seek');
      socket.off('user-joined');
      socket.off('new-message');
    };
  }, [socket, serverOffset]);

  // Audio Progress & Auto-next
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const updateProgress = () => {
      setCurrentTime(audio.currentTime);
      setDuration(audio.duration || 0);
    };

    const handleEnded = () => {
      if (isHost && socket) {
        socket.emit('next-track', { roomId });
      }
    };

    audio.addEventListener('timeupdate', updateProgress);
    audio.addEventListener('loadedmetadata', updateProgress);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('timeupdate', updateProgress);
      audio.removeEventListener('loadedmetadata', updateProgress);
      audio.removeEventListener('ended', handleEnded);
    };
  }, [isHost, socket, roomId]);

  // Scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleAuth = async (e: React.FormEvent, mode: 'login' | 'signup') => {
    e.preventDefault();
    const res = await fetch(`/api/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: authEmail, password: authPassword })
    });
    const data = await res.json();
    if (data.token) {
      setToken(data.token);
      setUserEmail(data.email);
      localStorage.setItem('token', data.token);
      localStorage.setItem('userEmail', data.email);
      setIsAuthMode(false);
    } else {
      alert(data.error);
    }
  };

  const joinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (socket && roomId && username) {
      socket.emit('join-room', { roomId, username, token });
      setJoined(true);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && socket && roomId) {
      const arrayBuffer = await file.arrayBuffer();
      socket.emit('add-to-queue', {
        roomId,
        audioData: arrayBuffer,
        fileName: file.name
      });
    }
  };

  const togglePlay = () => {
    if (!socket || !audioRef.current) return;
    if (isPlaying) {
      socket.emit('sync-pause', { roomId, seekTime: audioRef.current.currentTime });
    } else {
      socket.emit('sync-play', { roomId, seekTime: audioRef.current.currentTime });
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isHost || !socket || !audioRef.current) return;
    const seekTime = parseFloat(e.target.value);
    socket.emit('sync-seek', { roomId, seekTime });
  };

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (socket && messageInput.trim()) {
      socket.emit('send-message', { roomId, username, text: messageInput });
      setMessageInput('');
    }
  };

  const manualResync = () => {
    if (!socket) return;
    socket.emit('request-time', (serverTime: number) => {
      setServerOffset(serverTime - Date.now());
      setNeedsInteraction(false);
      if (audioRef.current && isPlaying) {
        audioRef.current.play().catch(() => setNeedsInteraction(true));
      }
    });
  };

  if (isAuthMode) {
    return (
      <div className="flex items-center justify-center min-h-screen p-4">
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="w-full max-w-md p-8 glass rounded-3xl">
          <h2 className="text-2xl font-bold mb-6 text-center">Authentication</h2>
          <form className="space-y-4">
            <input 
              type="email" placeholder="Email" value={authEmail} onChange={e => setAuthEmail(e.target.value)}
              className="w-full p-3 bg-white/5 border border-white/10 rounded-xl"
            />
            <input 
              type="password" placeholder="Password" value={authPassword} onChange={e => setAuthPassword(e.target.value)}
              className="w-full p-3 bg-white/5 border border-white/10 rounded-xl"
            />
            <div className="flex gap-4">
              <button onClick={e => handleAuth(e, 'login')} className="flex-1 py-3 bg-white text-black font-bold rounded-xl">Login</button>
              <button onClick={e => handleAuth(e, 'signup')} className="flex-1 py-3 border border-white/20 font-bold rounded-xl">Sign Up</button>
            </div>
            <button onClick={() => setIsAuthMode(false)} className="w-full text-white/40 text-sm">Cancel</button>
          </form>
        </motion.div>
      </div>
    );
  }

  if (!joined) {
    return (
      <div className="flex items-center justify-center min-h-screen p-4">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md p-8 glass rounded-3xl shadow-2xl"
        >
          <div className="flex flex-col items-center mb-8">
            <div className="p-4 mb-4 rounded-2xl bg-white/10">
              <Music className="w-12 h-12 text-white" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight">SyncWave</h1>
            <p className="text-white/60">Synchronized Music Broadcasting</p>
          </div>

          <form onSubmit={joinRoom} className="space-y-4">
            <div>
              <label className="block mb-2 text-sm font-medium text-white/60">Username</label>
              <input
                type="text" required value={username} onChange={(e) => setUsername(e.target.value)}
                className="w-full py-3 px-4 bg-white/5 border border-white/10 rounded-xl"
                placeholder="Your Name"
              />
            </div>
            <div>
              <label className="block mb-2 text-sm font-medium text-white/60">Room ID</label>
              <input
                type="text" required value={roomId} onChange={(e) => setRoomId(e.target.value)}
                className="w-full py-3 px-4 bg-white/5 border border-white/10 rounded-xl"
                placeholder="Enter Room ID"
              />
            </div>
            <button type="submit" className="w-full py-4 font-semibold text-black bg-white rounded-xl shadow-xl">
              Join Room
            </button>
            <div className="text-center pt-4 border-t border-white/10">
              {token ? (
                <p className="text-sm text-white/40">Logged in as {userEmail}</p>
              ) : (
                <button type="button" onClick={() => setIsAuthMode(true)} className="text-sm text-white/60 hover:text-white flex items-center justify-center gap-2 mx-auto">
                  <UserPlus className="w-4 h-4" /> Sign in for Host Privileges
                </button>
              )}
            </div>
          </form>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl px-4 py-8 mx-auto">
      <audio ref={audioRef} className="hidden" />
      
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-bold">Room: {roomId}</h2>
          <p className="text-white/60">Logged in as {username} {isHost && "(Host)"}</p>
        </div>
        <button onClick={manualResync} className="p-3 transition-all rounded-xl glass hover:bg-white/20">
          <RefreshCw className="w-5 h-5" />
        </button>
      </div>

      <div className="grid gap-8 lg:grid-cols-12">
        {/* Left: Player & Queue */}
        <div className="lg:col-span-8 space-y-6">
          <div className="p-8 glass rounded-3xl shadow-2xl relative overflow-hidden">
            <div className="relative z-10">
              <div className="flex items-center justify-center mb-8 aspect-video max-w-md mx-auto glass rounded-2xl shadow-inner">
                <div className="text-center p-4">
                  <Music className={cn("w-16 h-16 mx-auto mb-4 text-white/80", isPlaying && "animate-pulse")} />
                  <p className="text-lg font-bold truncate max-w-xs">
                    {currentTrackIndex >= 0 ? queue[currentTrackIndex]?.fileName : "No track playing"}
                  </p>
                </div>
              </div>

              <div className="mb-8 space-y-2">
                <input type="range" min="0" max={duration || 0} step="0.1" value={currentTime} onChange={handleSeek} disabled={!isHost} className="w-full" />
                <div className="flex justify-between text-xs font-mono text-white/40">
                  <span>{Math.floor(currentTime / 60)}:{(Math.floor(currentTime % 60)).toString().padStart(2, '0')}</span>
                  <span>{Math.floor(duration / 60)}:{(Math.floor(duration % 60)).toString().padStart(2, '0')}</span>
                </div>
              </div>

              <div className="flex items-center justify-center gap-8">
                <button className="p-2 text-white/40 hover:text-white"><SkipBack className="w-8 h-8" /></button>
                <button onClick={togglePlay} disabled={!isHost && !needsInteraction} className="p-6 bg-white rounded-full text-black shadow-xl">
                  {isPlaying ? <Pause className="w-8 h-8 fill-current" /> : <Play className="w-8 h-8 fill-current" />}
                </button>
                <button onClick={() => isHost && socket?.emit('next-track', { roomId })} className="p-2 text-white/40 hover:text-white">
                  <SkipForward className="w-8 h-8" />
                </button>
              </div>
            </div>
          </div>

          {/* Queue */}
          <div className="p-6 glass rounded-2xl">
            <h3 className="flex items-center gap-2 mb-4 font-semibold"><ListMusic className="w-5 h-5" /> Music Queue</h3>
            <div className="space-y-2">
              {queue.map((item, i) => (
                <div key={item.id} className={cn("flex items-center gap-3 p-3 rounded-xl border", i === currentTrackIndex ? "bg-white/10 border-white/20" : "bg-white/5 border-white/5")}>
                  <span className="text-xs text-white/40 w-4">{i + 1}</span>
                  <span className="text-sm flex-1 truncate">{item.fileName}</span>
                  {i === currentTrackIndex && <span className="text-[10px] uppercase text-white/60 font-bold">Playing</span>}
                </div>
              ))}
              {isHost && (
                <label className="flex items-center justify-center w-full p-4 mt-4 border-2 border-dashed rounded-xl border-white/10 hover:border-white/30 cursor-pointer">
                  <Plus className="w-5 h-5 mr-2 text-white/40" />
                  <span className="text-sm text-white/40">Add to Queue</span>
                  <input type="file" accept="audio/mpeg" onChange={handleFileUpload} className="hidden" />
                </label>
              )}
            </div>
          </div>
        </div>

        {/* Right: Chat & Participants */}
        <div className="lg:col-span-4 space-y-6 flex flex-col h-[calc(100vh-200px)]">
          {/* Chat */}
          <div className="flex-1 p-6 glass rounded-2xl flex flex-col min-h-0">
            <h3 className="flex items-center gap-2 mb-4 font-semibold"><MessageSquare className="w-5 h-5" /> Chat</h3>
            <div className="flex-1 overflow-y-auto space-y-4 mb-4 pr-2 custom-scrollbar">
              {messages.map((msg, i) => (
                <div key={i} className="space-y-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-bold text-white/80">{msg.username}</span>
                    <span className="text-[10px] text-white/30">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <p className="text-sm text-white/60 bg-white/5 p-2 rounded-lg rounded-tl-none">{msg.text}</p>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <form onSubmit={sendMessage} className="flex gap-2">
              <input 
                type="text" value={messageInput} onChange={e => setMessageInput(e.target.value)}
                placeholder="Type a message..."
                className="flex-1 p-2 bg-white/5 border border-white/10 rounded-lg text-sm"
              />
              <button type="submit" className="p-2 bg-white text-black rounded-lg"><Send className="w-4 h-4" /></button>
            </form>
          </div>

          {/* Participants */}
          <div className="p-6 glass rounded-2xl">
            <h3 className="flex items-center gap-2 mb-4 font-semibold"><Users className="w-5 h-5" /> Participants ({participants.length})</h3>
            <div className="flex flex-wrap gap-2">
              {participants.map((p, i) => (
                <div key={i} className="px-3 py-1 bg-white/10 rounded-full text-xs border border-white/10">{p}</div>
              ))}
            </div>
          </div>

          {/* Sync Warning */}
          {needsInteraction && (
            <div className="p-4 bg-white rounded-xl text-black">
              <p className="text-xs font-bold mb-2">Sync Required</p>
              <button onClick={manualResync} className="w-full py-2 bg-black text-white rounded-lg text-xs font-bold">Enable Audio</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
