require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const mkdir = promisify(fs.mkdir);
const unlink = promisify(fs.unlink);
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const access = promisify(fs.access);

// Configuration from .env
const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 500 * 1024 * 1024; // 500MB default

const HLS_DIR = path.join(__dirname, 'hls');
const MEDIA_DIR = path.join(__dirname, 'media');
const TEMP_DIR = path.join(__dirname, 'temp');

// Supported formats
const SUPPORTED_FORMATS = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.wma'];

// Initialize
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();

// Store for each group's stream state
const streams = new Map();
const activeStreams = new Set(); // Track active streaming group IDs

// Ensure directories exist
async function initDirectories() {
  await mkdir(HLS_DIR, { recursive: true });
  await mkdir(MEDIA_DIR, { recursive: true });
  await mkdir(TEMP_DIR, { recursive: true });
}

// Clean up old files (skip active streams)
async function cleanupOldFiles(dir, maxAge = 3600000) {
  try {
    const files = await readdir(dir);
    const now = Date.now();
    for (const file of files) {
      // Skip active stream folders
      if (dir === HLS_DIR && activeStreams.has(file)) {
        continue;
      }
      
      const filePath = path.join(dir, file);
      try {
        const stats = await stat(filePath);
        if (stats.isFile() && now - stats.mtimeMs > maxAge) {
          await unlink(filePath);
        } else if (stats.isDirectory() && now - stats.mtimeMs > maxAge) {
          // Cleanup empty directories
          const dirFiles = await readdir(filePath);
          if (dirFiles.length === 0) {
            fs.rmdirSync(filePath);
          }
        }
      } catch (e) {
        // File might be in use or already deleted
      }
    }
  } catch (err) {
    console.error('Cleanup error:', err);
  }
}

// Normalize media to standard format (H.264 + AAC)
async function normalizeMedia(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`Normalizing: ${path.basename(inputPath)}`);
    
    ffmpeg(inputPath)
      .outputOptions([
        '-c:v libx264',
        '-preset veryfast',
        '-crf 23',
        '-c:a aac',
        '-b:a 128k',
        '-ac 2',
        '-ar 44100',
        '-movflags +faststart',
        '-pix_fmt yuv420p'
      ])
      .output(outputPath)
      .on('start', (cmd) => {
        console.log('Normalization started');
      })
      .on('end', () => {
        console.log('Normalization complete');
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error('Normalization error:', err.message);
        reject(err);
      })
      .run();
  });
}

// Stream state management
class StreamState {
  constructor(groupId) {
    this.groupId = groupId;
    this.queue = [];
    this.normalizedFiles = [];
    this.currentIndex = -1;
    this.isStreaming = false;
    this.currentMetadata = null;
    this.ffmpegProcess = null;
    this.isProcessing = false;
    this.totalDuration = 0;
    this.startTime = null;
  }

  async addToQueue(filePath, metadata) {
    if (this.isProcessing) {
      console.log('Already processing, queuing...');
    }
    
    this.queue.push({ filePath, metadata });
    console.log(`Added to queue: ${metadata.name}. Queue length: ${this.queue.length}`);
    
    // Normalize the file immediately
    await this.normalizeNewFile(filePath, metadata);
    
    if (!this.isStreaming) {
      this.startStream();
    } else {
      // Update concat file for seamless append
      this.updateConcatFile();
    }
  }

  async normalizeNewFile(inputPath, metadata) {
    try {
      const outputPath = path.join(TEMP_DIR, `${this.groupId}_normalized_${Date.now()}.mp4`);
      await normalizeMedia(inputPath, outputPath);
      
      this.normalizedFiles.push({
        path: outputPath,
        metadata,
        duration: metadata.duration
      });
      
      this.totalDuration += metadata.duration;
      
      console.log(`Normalized file ready: ${metadata.name}`);
    } catch (err) {
      console.error('Failed to normalize:', err);
      throw err;
    }
  }

  updateConcatFile() {
    const groupHlsDir = path.join(HLS_DIR, this.groupId);
    const concatFilePath = path.join(groupHlsDir, 'concat.txt');
    
    const lines = this.normalizedFiles.map(item => 
      `file '${item.path.replace(/'/g, "'\\''")}'`
    ).join('\n');
    
    fs.writeFileSync(concatFilePath, lines);
  }

  async startStream() {
    if (this.isStreaming || this.normalizedFiles.length === 0) {
      return;
    }

    this.isStreaming = true;
    this.currentIndex = 0;
    this.startTime = Date.now();
    activeStreams.add(this.groupId);

    const groupHlsDir = path.join(HLS_DIR, this.groupId);
    await mkdir(groupHlsDir, { recursive: true });

    // Clear old segments
    await this.clearDirectory(groupHlsDir);

    const playlistPath = path.join(groupHlsDir, 'stream.m3u8');
    const segmentPattern = path.join(groupHlsDir, 'segment_%05d.ts');

    // Create concat file
    this.updateConcatFile();
    const concatFilePath = path.join(groupHlsDir, 'concat.txt');

    console.log('Starting HLS stream...');

    this.ffmpegProcess = ffmpeg()
      .input(concatFilePath)
      .inputOptions([
        '-f', 'concat',
        '-safe', '0',
        '-re' // Real-time streaming
      ])
      .outputOptions([
        '-c:v copy', // Copy already normalized video
        '-c:a copy', // Copy already normalized audio
        '-f', 'hls',
        '-hls_time', '4',
        '-hls_list_size', '10',
        '-hls_flags', 'delete_segments+append_list+omit_endlist',
        '-hls_segment_type', 'mpegts',
        '-hls_segment_filename', segmentPattern,
        '-start_number', '0',
        '-hls_allow_cache', '0',
        '-hls_playlist_type', 'event'
      ])
      .output(playlistPath)
      .on('start', (cmd) => {
        console.log('FFmpeg started');
      })
      .on('progress', (progress) => {
        this.updateCurrentPlaying(progress.timemark);
      })
      .on('end', async () => {
        console.log('Stream ended naturally');
        await this.handleStreamEnd();
      })
      .on('error', async (err, stdout, stderr) => {
        if (err.message.includes('SIGKILL') || err.message.includes('SIGTERM')) {
          console.log('Stream stopped by user');
        } else {
          console.error('FFmpeg error:', err.message);
          console.error('stderr:', stderr);
        }
        await this.handleStreamEnd();
      });

    this.ffmpegProcess.run();
  }

  updateCurrentPlaying(timemark) {
    if (!timemark || !this.startTime) return;

    // Parse timemark (HH:MM:SS.ms)
    const parts = timemark.split(':');
    if (parts.length !== 3) return;
    
    const seconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);

    // Calculate which media is currently playing
    let cumulative = 0;
    for (let i = 0; i < this.normalizedFiles.length; i++) {
      cumulative += this.normalizedFiles[i].duration;
      if (seconds < cumulative) {
        if (this.currentIndex !== i) {
          this.currentIndex = i;
          this.currentMetadata = this.normalizedFiles[i].metadata;
          console.log(`Now playing [${i + 1}/${this.normalizedFiles.length}]: ${this.currentMetadata.name}`);
        }
        break;
      }
    }
  }

  async clearDirectory(dir) {
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (file !== 'concat.txt') { // Keep concat file
          try {
            await unlink(path.join(dir, file));
          } catch (e) {
            // File might be in use
          }
        }
      }
    } catch (err) {
      // Directory might not exist
    }
  }

  async handleStreamEnd() {
    this.isStreaming = false;
    activeStreams.delete(this.groupId);
    
    // Write end list to playlist
    const groupHlsDir = path.join(HLS_DIR, this.groupId);
    const playlistPath = path.join(groupHlsDir, 'stream.m3u8');
    
    try {
      if (fs.existsSync(playlistPath)) {
        let content = fs.readFileSync(playlistPath, 'utf8');
        if (!content.includes('#EXT-X-ENDLIST')) {
          content += '\n#EXT-X-ENDLIST\n';
          fs.writeFileSync(playlistPath, content);
        }
      }
    } catch (e) {
      console.error('Error writing end list:', e);
    }
    
    // Cleanup normalized files after delay
    setTimeout(() => this.cleanup(), 60000); // 1 minute delay
  }

  async cleanup() {
    console.log(`Cleaning up stream: ${this.groupId}`);
    
    const groupHlsDir = path.join(HLS_DIR, this.groupId);
    
    // Delete normalized files
    for (const file of this.normalizedFiles) {
      try {
        if (fs.existsSync(file.path)) {
          await unlink(file.path);
        }
      } catch (e) {
        console.error('Error deleting normalized file:', e);
      }
    }
    
    // Delete original media files
    for (const item of this.queue) {
      try {
        if (fs.existsSync(item.filePath)) {
          await unlink(item.filePath);
        }
      } catch (e) {
        console.error('Error deleting original file:', e);
      }
    }
    
    // Clear HLS directory after some time
    setTimeout(async () => {
      try {
        await this.clearDirectory(groupHlsDir);
      } catch (e) {
        console.error('Error clearing HLS directory:', e);
      }
    }, 300000); // 5 minutes
  }

  stop() {
    console.log(`Stopping stream: ${this.groupId}`);
    
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGTERM'); // Graceful stop
      setTimeout(() => {
        if (this.ffmpegProcess) {
          this.ffmpegProcess.kill('SIGKILL'); // Force kill if needed
        }
      }, 5000);
      this.ffmpegProcess = null;
    }
    
    this.handleStreamEnd();
  }

  getCurrentState() {
    return {
      isStreaming: this.isStreaming,
      current: this.currentMetadata,
      currentIndex: this.currentIndex,
      queue: this.normalizedFiles.map(f => f.metadata),
      queueLength: this.normalizedFiles.length,
      totalDuration: this.totalDuration
    };
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
      bot.sendMessage(chatId, '⏹️ Stream stopped and will be cleaned up');
    } else {
      bot.sendMessage(chatId, 'No active stream');
    }
    return;
  }

  // Handle /play command
  if (msg.text && msg.text.startsWith('/play')) {
    const streamUrl = `${PUBLIC_URL}/${groupId}`;
    const stream = streams.get(groupId);
    
    if (stream && stream.isStreaming) {
      bot.sendMessage(chatId, `🔴 Stream is live:\n${streamUrl}`);
    } else {
      bot.sendMessage(chatId, 'No active stream. Send media files to start.');
    }
    return;
  }

  // Handle media files
  const mediaTypes = ['video', 'audio', 'document'];
  let fileId = null;
  let fileName = null;
  let fileSize = null;

  for (const type of mediaTypes) {
    if (msg[type]) {
      fileId = msg[type].file_id;
      fileName = msg[type].file_name || msg[type].title || `${type}_${Date.now()}`;
      fileSize = msg[type].file_size;
      break;
    }
  }

  if (fileId) {
    // Check file size
    if (fileSize && fileSize > MAX_FILE_SIZE) {
      bot.sendMessage(chatId, `❌ File too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). Max: ${MAX_FILE_SIZE / 1024 / 1024}MB`);
      return;
    }

    // Check file format
    const ext = path.extname(fileName).toLowerCase();
    if (!SUPPORTED_FORMATS.includes(ext)) {
      bot.sendMessage(chatId, `❌ Unsupported format: ${ext}\nSupported: ${SUPPORTED_FORMATS.join(', ')}`);
      return;
    }

    const processingMsg = await bot.sendMessage(chatId, '⏳ Downloading...');

    try {
      // Download file
      const file = await bot.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      const fileExt = path.extname(file.file_path);
      const filePath = path.join(MEDIA_DIR, `${groupId}_${Date.now()}${fileExt}`);

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

      await bot.editMessageText('⏳ Processing...', {
        chat_id: chatId,
        message_id: processingMsg.message_id
      });

      // Extract metadata
      const metadata = await extractMetadata(filePath, fileName);

      // Get or create stream state
      let stream = streams.get(groupId);
      if (!stream) {
        stream = new StreamState(groupId);
        streams.set(groupId, stream);
      }

      await bot.editMessageText('⏳ Normalizing...', {
        chat_id: chatId,
        message_id: processingMsg.message_id
      });

      await stream.addToQueue(filePath, metadata);

      const streamUrl = `${PUBLIC_URL}/${groupId}`;
      await bot.editMessageText(
        `✅ Added: ${metadata.name}\n` +
        `📋 Position: ${stream.queue.length}\n` +
        `⏱️ Duration: ${formatDuration(metadata.duration)}\n` +
        `🔴 Watch: ${streamUrl}`,
        { chat_id: chatId, message_id: processingMsg.message_id }
      );

    } catch (err) {
      console.error('Error processing media:', err);
      await bot.editMessageText(
        '❌ Error: ' + err.message,
        { chat_id: chatId, message_id: processingMsg.message_id }
      );
    }
  }
});

// Extract metadata
async function extractMetadata(filePath, fallbackName) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.error('FFprobe error:', err);
        resolve({
          name: fallbackName,
          duration: 0,
          type: 'unknown'
        });
        return;
      }

      const format = metadata.format;
      const tags = format.tags || {};
      
      const title = tags.title || tags.TITLE || path.basename(fallbackName, path.extname(fallbackName));
      const artist = tags.artist || tags.ARTIST || tags.album_artist || tags.ALBUM_ARTIST || '';
      const duration = parseFloat(format.duration) || 0;
      
      const hasVideo = metadata.streams.some(s => s.codec_type === 'video');
      const type = hasVideo ? 'video' : 'audio';

      resolve({
        name: artist ? `${artist} - ${title}` : title,
        duration,
        type,
        artist,
        title
      });
    });
  });
}

// Format duration helper
function formatDuration(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Express routes
app.use(express.json());

// Serve HLS content
app.use('/hls', express.static(HLS_DIR, {
  setHeaders: (res, path) => {
    if (path.endsWith('.m3u8')) {
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (path.endsWith('.ts')) {
      res.set('Content-Type', 'video/mp2t');
      res.set('Cache-Control', 'public, max-age=3600');
    }
  }
}));

// Main player page
app.get('/:groupId', (req, res) => {
  const groupId = req.params.groupId;
  
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🔴 Live Stream</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.4.12/dist/hls.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #fff;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    h1 {
      text-align: center;
      margin-bottom: 30px;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
    }
    .player-wrapper {
      background: rgba(0,0,0,0.7);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5);
      margin-bottom: 20px;
    }
    video {
      width: 100%;
      display: block;
      background: #000;
    }
    .info-bar {
      padding: 20px;
      background: rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      gap: 15px;
      flex-wrap: wrap;
    }
    .live-badge {
      background: #ff0000;
      padding: 8px 16px;
      border-radius: 20px;
      font-weight: bold;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    .live-dot {
      width: 8px;
      height: 8px;
      background: #fff;
      border-radius: 50%;
      animation: blink 1s infinite;
    }
    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }
    .now-playing {
      flex: 1;
      min-width: 200px;
    }
    .media-name {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 5px;
    }
    .media-type {
      opacity: 0.8;
      font-size: 14px;
    }
    .queue-section {
      background: rgba(0,0,0,0.5);
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 5px 20px rgba(0,0,0,0.3);
    }
    .queue-header {
      font-size: 20px;
      font-weight: bold;
      margin-bottom: 15px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .queue-count {
      background: rgba(255,255,255,0.2);
      padding: 5px 12px;
      border-radius: 15px;
      font-size: 14px;
    }
    .queue-item {
      padding: 12px;
      margin: 8px 0;
      background: rgba(255,255,255,0.1);
      border-radius: 8px;
      display: flex;
      align-items: center;
      gap: 12px;
      transition: background 0.3s;
    }
    .queue-item:hover {
      background: rgba(255,255,255,0.15);
    }
    .queue-item.current {
      background: rgba(76,175,80,0.3);
      border-left: 4px solid #4CAF50;
    }
    .queue-number {
      font-weight: bold;
      opacity: 0.7;
      min-width: 30px;
    }
    .queue-name {
      flex: 1;
    }
    .status-message {
      text-align: center;
      padding: 40px;
      font-size: 18px;
      opacity: 0.8;
    }
    .ended-message {
      text-align: center;
      padding: 30px;
      background: rgba(255,193,7,0.2);
      border-radius: 8px;
      margin: 20px 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔴 Live Stream</h1>
    
    <div class="player-wrapper">
      <video id="video" controls autoplay playsinline></video>
      <div class="info-bar">
        <div class="live-badge" id="live-badge" style="display: none;">
          <span class="live-dot"></span>
          LIVE
        </div>
        <div class="now-playing">
          <div class="media-name" id="media-name">Connecting to stream...</div>
          <div class="media-type" id="media-type"></div>
        </div>
      </div>
    </div>

    <div id="ended-notice" class="ended-message" style="display: none;">
      Stream has ended. The video above shows the complete recording.
    </div>

    <div class="queue-section">
      <div class="queue-header">
        <span>📋 Queue</span>
        <span class="queue-count" id="queue-count">0 items</span>
      </div>
      <div id="queue-items">
        <div class="status-message">No items in queue</div>
      </div>
    </div>
  </div>

  <script>
    const video = document.getElementById('video');
    const groupId = '${groupId}';
    const streamUrl = \`/hls/\${groupId}/stream.m3u8\`;
    
    let hls = null;
    let retryCount = 0;
    let streamEnded = false;
    const maxRetries = 15;

    function initPlayer() {
      if (streamEnded) return;
      
      console.log('Initializing player...');
      
      if (hls) {
        hls.destroy();
      }

      if (Hls.isSupported()) {
        hls = new Hls({
          debug: false,
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 90,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 10,
          liveDurationInfinity: false
        });
        
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        
        hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
          console.log('Manifest parsed');
          document.getElementById('live-badge').style.display = 'flex';
          video.play().catch(e => {
            console.log('Autoplay prevented');
          });
          retryCount = 0;
        });

        hls.on(Hls.Events.ERROR, (event, data) => {
          console.error('HLS Error:', data.type, data.details);
          
          if (data.details === 'manifestLoadError' && retryCount >= maxRetries) {
            console.log('Stream likely ended');
            handleStreamEnd();
            return;
          }
          
          if (data.fatal) {
            switch(data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                console.log('Network error, retrying...');
                if (retryCount < maxRetries) {
                  retryCount++;
                  setTimeout(() => {
                    if (hls) hls.startLoad();
                  }, 2000);
                } else {
                  handleStreamEnd();
                }
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                console.log('Media error, recovering...');
                hls.recoverMediaError();
                break;
              default:
                if (retryCount < maxRetries) {
                  retryCount++;
                  setTimeout(initPlayer, 3000);
                } else {
                  handleStreamEnd();
                }
                break;
            }
          }
        });

        hls.on(Hls.Events.FRAG_LOADED, () => {
          retryCount = 0;
        });

      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = streamUrl;
        video.addEventListener('loadedmetadata', () => {
          document.getElementById('live-badge').style.display = 'flex';
          video.play();
        });
      }
    }

    function handleStreamEnd() {
      streamEnded = true;
      document.getElementById('live-badge').style.display = 'none';
      document.getElementById('ended-notice').style.display = 'block';
      document.getElementById('media-name').textContent = 'Stream Ended';
      console.log('Stream has ended');
    }

    async function updateMetadata() {
      try {
        const response = await fetch(\`/api/metadata/\${groupId}\`);
        if (!response.ok) throw new Error('Metadata fetch failed');
        
        const data = await response.json();
        
        if (data.isStreaming && data.current) {
          document.getElementById('media-name').textContent = data.current.name;
          document.getElementById('media-type').textContent = 
            data.current.type === 'video' ? '🎬 Video' : '🎵 Audio';
          document.getElementById('live-badge').style.display = 'flex';
          document.getElementById('ended-notice').style.display = 'none';
        } else if (!data.isStreaming && data.queueLength > 0) {
          document.getElementById('media-name').textContent = 'Stream Ended';
          document.getElementById('media-type').textContent = '';
          handleStreamEnd();
        }
        
        const queueCount = data.queueLength || 0;
        document.getElementById('queue-count').textContent = \`\${queueCount} item\${queueCount !== 1 ? 's' : ''}\`;
        
        if (data.queue && data.queue.length > 0) {
          const queueHtml = data.queue.map((item, idx) => {
            const isCurrent = idx === data.currentIndex;
            return `<div class="queue-item ${isCurrent ? 'current' : ''}">
              <span class="queue-number">${idx + 1}.</span>
              <span class="queue-name">${item.name}</span>
            </div>`;
          }).join('');
          document.getElementById('queue-items').innerHTML = queueHtml;
        } else {
          document.getElementById('queue-items').innerHTML = 
            '<div class="status-message">No items in queue</div>';
        }
      } catch (e) {
        console.log('Metadata update error:', e);
      }
    }

    // Start
    initPlayer();
    updateMetadata();
    setInterval(updateMetadata, 2000);

    // Retry connection periodically if not ended
    setInterval(() => {
      if (!streamEnded && (!hls || !video.src)) {
        console.log('Checking stream availability...');
        initPlayer();
      }
    }, 10000);

    // Handle video ended event
    video.addEventListener('ended', () => {
      console.log('Video playback ended');
      setTimeout(() => {
        updateMetadata();
      }, 2000);
    });
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
    return res.json({
      isStreaming: false,
      current: null,
      currentIndex: -1,
      queue: [],
      queueLength: 0
    });
  }

  res.json(stream.getCurrentState());
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeStreams: activeStreams.size,
    uptime: process.uptime()
  });
});

// Start server
async function start() {
  if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN not found in .env file!');
    process.exit(1);
  }

  await initDirectories();
  
  // Periodic cleanup (skip active streams)
  setInterval(() => {
    console.log('Running cleanup...');
    cleanupOldFiles(MEDIA_DIR, 7200000); // 2 hours
    cleanupOldFiles(TEMP_DIR, 3600000); // 1 hour
    cleanupOldFiles(HLS_DIR, 3600000); // 1 hour
  }, 600000); // Every 10 minutes

  app.listen(PORT, () => {
    console.log(`🚀 Server: ${PUBLIC_URL}`);
    console.log(`🤖 Bot active`);
    console.log(`📁 Max file size: ${MAX_FILE_SIZE / 1024 / 1024}MB`);
  });
}

start().catch(console.error);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  
  // Stop all streams
  for (const [groupId, stream] of streams.entries()) {
    stream.stop();
  }
  
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down...');
  
  // Stop all streams
  for (const [groupId, stream] of streams.entries()) {
    stream.stop();
  }
  
  process.exit(0);
});
