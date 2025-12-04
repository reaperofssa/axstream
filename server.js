const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const mkdir = promisify(fs.mkdir);
const unlink = promisify(fs.unlink);
const readdir = promisify(fs.readdir);

// Configuration
const BOT_TOKEN = '8334704739:AAFJztoXYELAKvXnhV6IydFkrGFAy8PqI-4';
const PORT = 3000;
const HLS_DIR = path.join(__dirname, 'hls');
const MEDIA_DIR = path.join(__dirname, 'media');

// Initialize
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();

// Store for each group's stream state
const streams = new Map();

// Ensure directories exist
async function initDirectories() {
  await mkdir(HLS_DIR, { recursive: true });
  await mkdir(MEDIA_DIR, { recursive: true });
}

// Stream state management
class StreamState {
  constructor(groupId) {
    this.groupId = groupId;
    this.queue = [];
    this.currentIndex = 0;
    this.isStreaming = false;
    this.currentMetadata = null;
    this.ffmpegProcess = null;
    this.segmentIndex = 0;
  }

  addToQueue(filePath, metadata) {
    this.queue.push({ filePath, metadata });
    if (!this.isStreaming) {
      this.startStreaming();
    }
  }

  async startStreaming() {
    if (this.queue.length === 0) {
      this.isStreaming = false;
      return;
    }

    this.isStreaming = true;
    await this.streamNextMedia();
  }

  async streamNextMedia() {
    if (this.currentIndex >= this.queue.length) {
      this.isStreaming = false;
      await this.cleanup();
      return;
    }

    const { filePath, metadata } = this.queue[this.currentIndex];
    this.currentMetadata = metadata;

    const groupHlsDir = path.join(HLS_DIR, this.groupId);
    await mkdir(groupHlsDir, { recursive: true });

    const playlistPath = path.join(groupHlsDir, 'stream.m3u8');
    const segmentPattern = path.join(groupHlsDir, `segment%d.ts`);

    // Clear old segments
    await this.clearSegments(groupHlsDir);

    return new Promise((resolve) => {
      this.ffmpegProcess = ffmpeg(filePath)
        .outputOptions([
          '-c:v libx264',
          '-c:a aac',
          '-b:a 128k',
          '-ac 2',
          '-ar 44100',
          '-preset veryfast',
          '-g 60',
          '-sc_threshold 0',
          '-f hls',
          '-hls_time 2',
          '-hls_list_size 5',
          '-hls_flags delete_segments+append_list',
          `-hls_segment_filename ${segmentPattern}`,
          '-start_number ' + this.segmentIndex
        ])
        .output(playlistPath)
        .on('start', (cmd) => {
          console.log(`Started streaming: ${metadata.name}`);
        })
        .on('end', async () => {
          console.log(`Finished streaming: ${metadata.name}`);
          this.currentIndex++;
          this.segmentIndex += 1000; // Increment to avoid segment number conflicts
          
          // Seamlessly transition to next media
          if (this.currentIndex < this.queue.length) {
            await this.streamNextMedia();
          } else {
            this.isStreaming = false;
            await this.cleanup();
          }
          resolve();
        })
        .on('error', (err) => {
          console.error(`Streaming error: ${err.message}`);
          this.currentIndex++;
          this.streamNextMedia();
          resolve();
        })
        .run();
    });
  }

  async clearSegments(dir) {
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (file.endsWith('.ts')) {
          await unlink(path.join(dir, file));
        }
      }
    } catch (err) {
      // Directory might not exist yet
    }
  }

  async cleanup() {
    const groupHlsDir = path.join(HLS_DIR, this.groupId);
    try {
      await this.clearSegments(groupHlsDir);
      const playlistPath = path.join(groupHlsDir, 'stream.m3u8');
      if (fs.existsSync(playlistPath)) {
        await unlink(playlistPath);
      }
    } catch (err) {
      console.error('Cleanup error:', err);
    }
  }

  stop() {
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGKILL');
      this.ffmpegProcess = null;
    }
    this.isStreaming = false;
    this.queue = [];
    this.currentIndex = 0;
    this.cleanup();
  }
}

// Bot command handlers
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const groupId = chatId.toString();

  // Handle /stop command
  if (msg.text === '/stop') {
    const stream = streams.get(groupId);
    if (stream) {
      stream.stop();
      streams.delete(groupId);
      bot.sendMessage(chatId, '⏹️ Stream stopped');
    } else {
      bot.sendMessage(chatId, 'No active stream');
    }
    return;
  }

  // Handle media files (video, audio, documents)
  const mediaTypes = ['video', 'audio', 'document'];
  let fileId = null;
  let fileName = null;
  let mediaType = null;

  for (const type of mediaTypes) {
    if (msg[type]) {
      fileId = msg[type].file_id;
      fileName = msg[type].file_name || msg[type].title || `${type}_${Date.now()}`;
      mediaType = type;
      break;
    }
  }

  if (fileId) {
    bot.sendMessage(chatId, '⏳ Adding to queue...');

    try {
      // Download file
      const file = await bot.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      const filePath = path.join(MEDIA_DIR, `${groupId}_${Date.now()}_${path.basename(file.file_path)}`);

      // Download using node-fetch or axios (you'll need to install one)
      const https = require('https');
      const fileStream = fs.createWriteStream(filePath);
      
      await new Promise((resolve, reject) => {
        https.get(fileUrl, (response) => {
          response.pipe(fileStream);
          fileStream.on('finish', () => {
            fileStream.close();
            resolve();
          });
        }).on('error', reject);
      });

      // Extract metadata
      const metadata = await extractMetadata(filePath, fileName);

      // Get or create stream state
      let stream = streams.get(groupId);
      if (!stream) {
        stream = new StreamState(groupId);
        streams.set(groupId, stream);
      }

      stream.addToQueue(filePath, metadata);

      const streamUrl = `http://localhost:${PORT}/${groupId}`;
      bot.sendMessage(chatId, 
        `✅ Added to queue: ${metadata.name}\n` +
        `🔴 Stream: ${streamUrl}\n` +
        `📋 Queue position: ${stream.queue.length}`
      );

    } catch (err) {
      console.error('Error processing media:', err);
      bot.sendMessage(chatId, '❌ Error processing media file');
    }
  }
});

// Extract metadata from file
async function extractMetadata(filePath, fallbackName) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        resolve({
          name: fallbackName,
          duration: 0,
          type: 'unknown'
        });
        return;
      }

      const format = metadata.format;
      const tags = format.tags || {};
      
      const name = tags.title || tags.TITLE || path.basename(fallbackName, path.extname(fallbackName));
      const artist = tags.artist || tags.ARTIST || '';
      const duration = format.duration || 0;
      
      const hasVideo = metadata.streams.some(s => s.codec_type === 'video');
      const type = hasVideo ? 'video' : 'audio';

      resolve({
        name: artist ? `${artist} - ${name}` : name,
        duration,
        type,
        artist,
        title: name
      });
    });
  });
}

// Express routes
app.use(express.static('public'));

// Serve HLS segments and playlists
app.use('/hls', express.static(HLS_DIR));

// Stream player page
app.get('/:groupId', (req, res) => {
  const groupId = req.params.groupId;
  const stream = streams.get(groupId);

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Live Stream</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #000;
      color: #fff;
      font-family: Arial, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    #player-container {
      width: 100%;
      max-width: 1200px;
      background: #111;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    }
    video {
      width: 100%;
      display: block;
    }
    #metadata {
      padding: 20px;
      background: #1a1a1a;
    }
    #now-playing {
      font-size: 24px;
      font-weight: bold;
      margin-bottom: 10px;
    }
    #queue {
      margin-top: 20px;
      padding: 20px;
      background: #0a0a0a;
      border-radius: 8px;
      max-width: 1200px;
      width: 100%;
    }
    .queue-item {
      padding: 10px;
      margin: 5px 0;
      background: #1a1a1a;
      border-radius: 4px;
    }
    .live-indicator {
      display: inline-block;
      width: 10px;
      height: 10px;
      background: #ff0000;
      border-radius: 50%;
      margin-right: 10px;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
  </style>
</head>
<body>
  <div id="player-container">
    <video id="video" controls autoplay></video>
    <div id="metadata">
      <div id="now-playing">
        <span class="live-indicator"></span>
        <span id="media-name">Waiting for stream...</span>
      </div>
      <div id="media-type"></div>
    </div>
  </div>
  <div id="queue">
    <h3>Queue</h3>
    <div id="queue-items"></div>
  </div>

  <script>
    const video = document.getElementById('video');
    const streamUrl = '/hls/${groupId}/stream.m3u8';
    
    let hls;
    
    function initPlayer() {
      if (Hls.isSupported()) {
        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 90
        });
        
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        
        hls.on(Hls.Events.MANIFEST_PARSED, function() {
          video.play().catch(e => console.log('Autoplay prevented:', e));
        });

        hls.on(Hls.Events.ERROR, function(event, data) {
          console.log('HLS Error:', data);
          if (data.fatal) {
            setTimeout(initPlayer, 2000);
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = streamUrl;
        video.addEventListener('loadedmetadata', function() {
          video.play();
        });
      }
    }

    // Poll for metadata updates
    async function updateMetadata() {
      try {
        const response = await fetch('/api/metadata/${groupId}');
        const data = await response.json();
        
        if (data.current) {
          document.getElementById('media-name').textContent = data.current.name;
          document.getElementById('media-type').textContent = 
            data.current.type === 'video' ? '🎬 Video' : '🎵 Audio';
        }
        
        if (data.queue) {
          const queueHtml = data.queue.map((item, idx) => 
            \`<div class="queue-item">\${idx + 1}. \${item.name}</div>\`
          ).join('');
          document.getElementById('queue-items').innerHTML = queueHtml || 'Queue is empty';
        }
      } catch (e) {
        console.log('Metadata fetch error:', e);
      }
    }

    initPlayer();
    setInterval(updateMetadata, 2000);
    updateMetadata();
  </script>
</body>
</html>
  `);
});

// API endpoint for metadata
app.get('/api/metadata/:groupId', (req, res) => {
  const groupId = req.params.groupId;
  const stream = streams.get(groupId);

  if (!stream) {
    return res.json({ current: null, queue: [] });
  }

  res.json({
    current: stream.currentMetadata,
    queue: stream.queue.slice(stream.currentIndex + 1).map(q => q.metadata)
  });
});

// Start server
async function start() {
  await initDirectories();
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🤖 Bot is active`);
  });
}

start().catch(console.error);
