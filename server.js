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

// Configuration from .env
const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 500 * 1024 * 1024;
const AD_VIDEO_PATH = process.env.AD_VIDEO_PATH || 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';

const HLS_DIR = path.join(__dirname, 'hls');
const MEDIA_DIR = path.join(__dirname, 'media');
const TEMP_DIR = path.join(__dirname, 'temp');
const ADS_DIR = path.join(__dirname, 'ads');

const SUPPORTED_FORMATS = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.wma'];

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();

const streams = new Map();
const activeStreams = new Set();

async function initDirectories() {
  await mkdir(HLS_DIR, { recursive: true });
  await mkdir(MEDIA_DIR, { recursive: true });
  await mkdir(TEMP_DIR, { recursive: true });
  await mkdir(ADS_DIR, { recursive: true });
}

async function getAdVideo() {
  const adPath = path.join(__dirname, 'ad', 'ad.mp4'); // hardcoded location
  if (!fs.existsSync(adPath)) {
    throw new Error(`Ad video not found at ${adPath}. Please place it manually.`);
  }
  console.log('Using local ad video:', adPath);
  return adPath;
}


async function cleanupOldFiles(dir, maxAge = 3600000) {
  try {
    const files = await readdir(dir);
    const now = Date.now();
    for (const file of files) {
      if (dir === HLS_DIR && activeStreams.has(file)) continue;
      if (dir === ADS_DIR) continue; // Never delete ads
      
      const filePath = path.join(dir, file);
      try {
        const stats = await stat(filePath);
        if (stats.isFile() && now - stats.mtimeMs > maxAge) {
          await unlink(filePath);
        }
      } catch (e) {}
    }
  } catch (err) {}
}

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
        '-pix_fmt yuv420p',
        '-profile:v baseline',
        '-level 3.0'
      ])
      .output(outputPath)
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

class StreamState {
  constructor(groupId) {
    this.groupId = groupId;
    this.queue = [];
    this.normalizedFiles = [];
    this.currentIndex = 0;
    this.isStreaming = false;
    this.currentMetadata = null;
    this.ffmpegProcess = null;
    this.isProcessing = false;
    this.totalDuration = 0;
    this.adPath = null;
    this.playingAd = false;
    this.shouldRestart = false;
  }

  async init() {
  this.adPath = await getAdVideo(); // uses local ad.mp4
  const normalizedAdPath = path.join(TEMP_DIR, `${this.groupId}_ad.mp4`);
  
  if (!fs.existsSync(normalizedAdPath)) {
    await normalizeMedia(this.adPath, normalizedAdPath);
  }
  
  this.adPath = normalizedAdPath;
}

  async addToQueue(filePath, metadata) {
    this.queue.push({ filePath, metadata });
    console.log(`Added to queue: ${metadata.name}. Queue: ${this.queue.length}`);
    
    await this.normalizeNewFile(filePath, metadata);
    
    if (!this.isStreaming) {
      this.startStream();
    } else {
      this.shouldRestart = true;
      this.restartStream();
    }
  }

  async normalizeNewFile(inputPath, metadata) {
    try {
      const outputPath = path.join(TEMP_DIR, `${this.groupId}_${Date.now()}.mp4`);
      await normalizeMedia(inputPath, outputPath);
      
      this.normalizedFiles.push({
        path: outputPath,
        metadata,
        duration: metadata.duration
      });
      
      this.totalDuration += metadata.duration;
      console.log(`Normalized: ${metadata.name}`);
    } catch (err) {
      console.error('Normalization failed:', err);
      throw err;
    }
  }

  buildConcatList() {
    const items = [];
    
    // If no media, loop ads
    if (this.normalizedFiles.length === 0) {
      for (let i = 0; i < 10; i++) { // Loop ad 10 times
        items.push(this.adPath);
      }
      this.playingAd = true;
    } else {
      // Play all media
      for (const file of this.normalizedFiles) {
        items.push(file.path);
      }
      this.playingAd = false;
    }
    
    return items.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  }

  updateConcatFile() {
    const groupHlsDir = path.join(HLS_DIR, this.groupId);
    const concatFilePath = path.join(groupHlsDir, 'concat.txt');
    const content = this.buildConcatList();
    fs.writeFileSync(concatFilePath, content);
  }

  async restartStream() {
    if (!this.shouldRestart || this.isProcessing) return;
    
    console.log('Restarting stream with new content...');
    this.isProcessing = true;
    
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    this.isProcessing = false;
    this.shouldRestart = false;
    await this.startStream();
  }

  async startStream() {
    if (this.isStreaming) return;
    
    if (!this.adPath) {
      await this.init();
    }

    this.isStreaming = true;
    this.currentIndex = 0;
    activeStreams.add(this.groupId);

    const groupHlsDir = path.join(HLS_DIR, this.groupId);
    await mkdir(groupHlsDir, { recursive: true });

    await this.clearDirectory(groupHlsDir);

    const playlistPath = path.join(groupHlsDir, 'stream.m3u8');
    const segmentPattern = path.join(groupHlsDir, 'seg%05d.ts');

    this.updateConcatFile();
    const concatFilePath = path.join(groupHlsDir, 'concat.txt');

    console.log('Starting HLS stream...');

    this.ffmpegProcess = ffmpeg()
      .input(concatFilePath)
      .inputOptions([
        '-f', 'concat',
        '-safe', '0',
        '-re',
        '-stream_loop', '-1' // Loop the concat list
      ])
      .outputOptions([
        '-c:v copy',
        '-c:a copy',
        '-f', 'hls',
        '-hls_time', '2',
        '-hls_list_size', '5',
        '-hls_flags', 'delete_segments+omit_endlist',
        '-hls_segment_type', 'mpegts',
        '-hls_segment_filename', segmentPattern,
        '-start_number', '0',
        '-hls_allow_cache', '0'
      ])
      .output(playlistPath)
      .on('start', (cmd) => {
        console.log('FFmpeg started (continuous loop mode)');
      })
      .on('progress', (progress) => {
        this.updateCurrentPlaying(progress.timemark);
      })
      .on('error', async (err) => {
        if (!err.message.includes('SIGTERM') && !err.message.includes('SIGKILL')) {
          console.error('FFmpeg error:', err.message);
        }
      });

    this.ffmpegProcess.run();
  }

  updateCurrentPlaying(timemark) {
    if (!timemark || this.normalizedFiles.length === 0) {
      this.currentMetadata = this.playingAd ? { name: 'Advertisement', type: 'video' } : null;
      return;
    }

    const parts = timemark.split(':');
    if (parts.length !== 3) return;
    
    const seconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);

    let cumulative = 0;
    for (let i = 0; i < this.normalizedFiles.length; i++) {
      cumulative += this.normalizedFiles[i].duration;
      if (seconds < cumulative) {
        if (this.currentIndex !== i) {
          this.currentIndex = i;
          this.currentMetadata = this.normalizedFiles[i].metadata;
          this.playingAd = false;
          console.log(`Now: [${i + 1}/${this.normalizedFiles.length}] ${this.currentMetadata.name}`);
        }
        return;
      }
    }
  }

  async clearDirectory(dir) {
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (file !== 'concat.txt') {
          try {
            await unlink(path.join(dir, file));
          } catch (e) {}
        }
      }
    } catch (err) {}
  }

  async cleanup() {
    console.log(`Cleanup: ${this.groupId}`);
    
    for (const file of this.normalizedFiles) {
      try {
        if (fs.existsSync(file.path)) {
          await unlink(file.path);
        }
      } catch (e) {}
    }
    
    for (const item of this.queue) {
      try {
        if (fs.existsSync(item.filePath)) {
          await unlink(item.filePath);
        }
      } catch (e) {}
    }
  }

  stop() {
    console.log(`Stopping: ${this.groupId}`);
    
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGTERM');
      setTimeout(() => {
        if (this.ffmpegProcess) {
          this.ffmpegProcess.kill('SIGKILL');
        }
      }, 3000);
      this.ffmpegProcess = null;
    }
    
    this.isStreaming = false;
    activeStreams.delete(this.groupId);
    this.cleanup();
  }

  getCurrentState() {
    return {
      isStreaming: this.isStreaming,
      current: this.currentMetadata || (this.playingAd ? { name: 'Advertisement', type: 'video' } : null),
      currentIndex: this.currentIndex,
      queue: this.normalizedFiles.map(f => f.metadata),
      queueLength: this.normalizedFiles.length,
      totalDuration: this.totalDuration,
      playingAd: this.playingAd
    };
  }
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const groupId = chatId.toString();

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

  if (msg.text && msg.text.startsWith('/play')) {
    const streamUrl = `${PUBLIC_URL}/${groupId}`;
    bot.sendMessage(chatId, `🔴 Stream: ${streamUrl}`);
    return;
  }

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
    if (fileSize && fileSize > MAX_FILE_SIZE) {
      bot.sendMessage(chatId, `❌ File too large (${(fileSize/1024/1024).toFixed(1)}MB). Max: ${MAX_FILE_SIZE/1024/1024}MB`);
      return;
    }

    const ext = path.extname(fileName).toLowerCase();
    if (!SUPPORTED_FORMATS.includes(ext)) {
      bot.sendMessage(chatId, `❌ Unsupported: ${ext}\\nSupported: ${SUPPORTED_FORMATS.join(', ')}`);
      return;
    }

    const processingMsg = await bot.sendMessage(chatId, '⏳ Downloading...');

    try {
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

      const metadata = await extractMetadata(filePath, fileName);

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
        `✅ Added: ${metadata.name}\\n📋 Position: ${stream.queue.length}\\n⏱️ Duration: ${formatDuration(metadata.duration)}\\n🔴 Watch: ${streamUrl}`,
        { chat_id: chatId, message_id: processingMsg.message_id }
      );

    } catch (err) {
      console.error('Error:', err);
      await bot.editMessageText('❌ Error: ' + err.message, {
        chat_id: chatId,
        message_id: processingMsg.message_id
      });
    }
  }
});

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
      
      const title = tags.title || tags.TITLE || path.basename(fallbackName, path.extname(fallbackName));
      const artist = tags.artist || tags.ARTIST || '';
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

function formatDuration(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

app.use(express.json());

app.use('/hls', express.static(HLS_DIR, {
  setHeaders: (res, filepath) => {
    if (filepath.endsWith('.m3u8')) {
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'no-cache');
    } else if (filepath.endsWith('.ts')) {
      res.set('Content-Type', 'video/mp2t');
      res.set('Cache-Control', 'max-age=3600');
    }
  }
}));

app.get('/:groupId', (req, res) => {
  const groupId = req.params.groupId;
  
  res.send(`<!DOCTYPE html>
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
.container { max-width: 1400px; margin: 0 auto; }
h1 { text-align: center; margin-bottom: 30px; text-shadow: 2px 2px 4px rgba(0,0,0,0.3); }
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
.now-playing { flex: 1; min-width: 200px; }
.media-name { font-size: 18px; font-weight: 600; margin-bottom: 5px; }
.media-type { opacity: 0.8; font-size: 14px; }
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
}
.queue-item.current {
background: rgba(76,175,80,0.3);
border-left: 4px solid #4CAF50;
}
.queue-number { font-weight: bold; opacity: 0.7; min-width: 30px; }
.queue-name { flex: 1; }
.status-message { text-align: center; padding: 40px; font-size: 18px; opacity: 0.8; }
.ad-badge {
background: #ffa500;
padding: 4px 8px;
border-radius: 4px;
font-size: 12px;
margin-left: 10px;
}
</style>
</head>
<body>
<div class="container">
<h1>🔴 Live Stream</h1>
<div class="player-wrapper">
<video id="video" controls autoplay playsinline muted></video>
<div class="info-bar">
<div class="live-badge">
<span class="live-dot"></span>
LIVE
</div>
<div class="now-playing">
<div class="media-name" id="media-name">Connecting...</div>
<div class="media-type" id="media-type"></div>
</div>
</div>
</div>
<div class="queue-section">
<div class="queue-header">
<span>📋 Queue</span>
<span class="queue-count" id="queue-count">0 items</span>
</div>
<div id="queue-items">
<div class="status-message">Waiting for content...</div>
</div>
</div>
</div>
<script>
const video = document.getElementById('video');
const groupId = '${groupId}';
const streamUrl = \`/hls/\${groupId}/stream.m3u8\`;
let hls = null;

function initPlayer() {
console.log('Init player');
if (hls) hls.destroy();

if (Hls.isSupported()) {
hls = new Hls({
debug: false,
enableWorker: true,
lowLatencyMode: false,
backBufferLength: 10,
maxBufferLength: 30,
maxMaxBufferLength: 60,
maxBufferSize: 60 * 1000 * 1000,
maxBufferHole: 0.5,
highBufferWatchdogPeriod: 2,
nudgeOffset: 0.1,
nudgeMaxRetry: 3,
maxFragLookUpTolerance: 0.25,
liveSyncDurationCount: 3,
liveMaxLatencyDurationCount: 10
});

hls.loadSource(streamUrl);
hls.attachMedia(video);

hls.on(Hls.Events.MANIFEST_PARSED, () => {
console.log('Manifest parsed');
video.play().catch(e => {
console.log('Click to play');
video.muted = true;
video.play();
});
});

hls.on(Hls.Events.ERROR, (event, data) => {
if (data.fatal) {
switch(data.type) {
case Hls.ErrorTypes.NETWORK_ERROR:
console.log('Network error, recovering...');
setTimeout(() => hls.startLoad(), 1000);
break;
case Hls.ErrorTypes.MEDIA_ERROR:
console.log('Media error, recovering...');
hls.recoverMediaError();
break;
default:
console.log('Fatal error');
setTimeout(initPlayer, 3000);
break;
}
}
});

} else if (video.canPlayType('application/vnd.apple.mpegurl')) {
video.src = streamUrl;
video.play();
}
}

async function updateMetadata() {
try {
const response = await fetch(\`/api/metadata/\${groupId}\`);
const data = await response.json();

if (data.current) {
let name = data.current.name;
if (data.playingAd) name += ' <span class="ad-badge">AD</span>';
document.getElementById('media-name').innerHTML = name;
document.getElementById('media-type').textContent = 
data.current.type === 'video' ? '🎬 Video' : '🎵 Audio';
}

const queueCount = data.queueLength || 0;
document.getElementById('queue-count').textContent = \`\${queueCount} item\${queueCount !== 1 ? 's' : ''}\`;

if (data.queue && data.queue.length > 0) {
const queueHtml = data.queue.map((item, idx) => {
const isCurrent = idx === data.currentIndex;
return \`<div class="queue-item \${isCurrent ? 'current' : ''}">
<span class="queue-number">\${idx + 1}.</span>
<span class="queue-name">\${item.name}</span>
</div>\`;
}).join('');
document.getElementById('queue-items').innerHTML = queueHtml;
} else {
document.getElementById('queue-items').innerHTML = 
'<div class="status-message">Send media to bot to start streaming</div>';
}
} catch (e) {
console.log('Update error:', e);
}
}

initPlayer();
updateMetadata();
setInterval(updateMetadata, 2000);
setInterval(() => {
if (!hls || hls.media.paused) initPlayer();
}, 10000);
</script>
</body>
</html>`);
});

app.get('/api/metadata/:groupId', (req, res) => {
  const groupId = req.params.groupId;
  const stream = streams.get(groupId);

  if (!stream) {
    return res.json({
      isStreaming: false,
      current: null,
      currentIndex: -1,
      queue: [],
      queueLength: 0,
      playingAd: false
    });
  }

  res.json(stream.getCurrentState());
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeStreams: activeStreams.size,
    uptime: process.uptime()
  });
});

async function start() {
  if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN not in .env!');
    process.exit(1);
  }

  await initDirectories();
  
  setInterval(() => {
    cleanupOldFiles(MEDIA_DIR, 7200000);
    cleanupOldFiles(TEMP_DIR, 3600000);
  }, 600000);

  app.listen(PORT, () => {
    console.log(`🚀 Server: ${PUBLIC_URL}`);
    console.log(`🤖 Bot active`);
  });
}

start().catch(console.error);

process.on('SIGINT', () => {
  console.log('\\n🛑 Shutting down...');
  for (const [, stream] of streams.entries()) {
    stream.stop();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\\n🛑 Shutting down...');
  for (const [, stream] of streams.entries()) {
    stream.stop();
  }
  process.exit(0);
});
