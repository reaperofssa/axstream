const { spawn } = require('child_process');
const express = require('express');
const fs = require('fs');
const cors = require('cors');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');

const PORT = 7860;
const TELEGRAM_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';

const app = express();
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const baseOutputDir = path.join(__dirname, 'hls_output');
const publicDir = path.join(__dirname, 'public');
const adVideoPath = path.join(__dirname, 'ad', 'ad.mp4');
const watermarkText = 'AnitakuX';
const channelsFile = path.join(__dirname, 'channels.json');

app.use(cors());
app.use(express.static(publicDir));
app.use(express.json());

// Global state to track channels
const channelStates = {};
let channels = {};

// Load channels from JSON file
try {
  channels = JSON.parse(fs.readFileSync(channelsFile));
} catch (err) {
  channels = {};
  fs.writeFileSync(channelsFile, JSON.stringify(channels, null, 2));
}

// ==================== HELPER FUNCTIONS ====================

function formatWATTime(date) {
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Lagos'  // WAT
  });
}

async function getVideoDuration(filePath) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.log(`Timeout getting duration for ${filePath}, using fallback`);
      resolve(90 * 60 * 1000);
    }, 10000);

    ffmpeg.ffprobe(filePath, (err, metadata) => {
      clearTimeout(timeout);
      if (err) {
        console.error(`Error probing video duration:`, err);
        return resolve(90 * 60 * 1000);
      }
      const durationSeconds = metadata.format.duration || 90 * 60;
      resolve(durationSeconds * 1000);
    });
  });
}

async function generateDynamicSchedule(channelId, channelConfig, currentMovieInfo) {
  const schedule = [];
  let currentTime = new Date();

  if (currentMovieInfo) {
    schedule.push({
      title: currentMovieInfo.title,
      startTime: formatWATTime(currentMovieInfo.startTime),
      endTime: formatWATTime(currentMovieInfo.endTime),
      current: true
    });
    currentTime = new Date(currentMovieInfo.endTime.getTime() + 1000);
  }

  if (!channelConfig.queue || channelConfig.queue.length === 0) return schedule;

  for (let i = 0; i < Math.min(channelConfig.queue.length, 10); i++) {
    const movie = channelConfig.queue[i];
    const duration = await getVideoDuration(movie.filePath);
    const startTime = new Date(currentTime);
    const endTime = new Date(currentTime.getTime() + duration);

    schedule.push({
      title: movie.title,
      startTime: formatWATTime(startTime),
      endTime: formatWATTime(endTime),
      current: false
    });

    currentTime = new Date(endTime.getTime() + 1000);
  }

  return schedule;
}

function startFFmpeg(channelId, inputPath, outputDir, movieTitle, slotId, onExit, onReady, isAd = false) {
  // VERIFY INPUT FILE EXISTS
  if (!fs.existsSync(inputPath)) {
    console.error(`❌ [${channelId}-${slotId}] Input file not found: ${inputPath}`);
    if (onExit) onExit(-1);
    return null;
  }

  // VERIFY INPUT FILE IS READABLE
  try {
    fs.accessSync(inputPath, fs.constants.R_OK);
  } catch (error) {
    console.error(`❌ [${channelId}-${slotId}] Input file not readable: ${inputPath}`);
    if (onExit) onExit(-1);
    return null;
  }

  const args = [
  '-stream_loop', isAd ? '-1' : '0',
  '-re', '-i', inputPath,
  '-vf', `drawtext=text='${watermarkText}':fontcolor=white:fontsize=24:x=w-tw-20:y=20${!isAd ? `,drawtext=text='${movieTitle}':fontcolor=white:fontsize=20:x=w-tw-20:y=h-th-20` : ''}`,
  '-c:v', 'libx264', 
  '-preset', 'ultrafast',  // Fastest encoding
  '-tune', 'zerolatency',  // Minimize latency
  '-crf', '28',  // Lower quality = faster encoding
  '-maxrate', '2M', '-bufsize', '4M',  // Limit bitrate
  '-c:a', 'aac', '-b:a', '96k',  // Lower audio bitrate
  '-g', '30',  // Smaller GOP = faster start
  '-sc_threshold', '0',
  '-f', 'hls',
  '-hls_time', '2',  // 2-second segments
  '-hls_list_size', '6',  // Keep only 6 segments
  '-hls_flags', 'delete_segments+independent_segments',
  '-hls_segment_type', 'mpegts',
  '-hls_segment_filename', path.join(outputDir, `segment_${slotId}_%03d.ts`),
  '-master_pl_name', `master_${slotId}.m3u8`,
  '-y',
  path.join(outputDir, `stream_${slotId}.m3u8`)
];

  console.log(`🔴 [${channelId}] Starting FFmpeg slot ${slotId} for ${isAd ? 'Ad Loop' : movieTitle}`);
  const proc = spawn('ffmpeg', args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let isReady = false;
  let readyCheckTimeout = null;
  let segmentCheckInterval = null;
  const REQUIRED_SEGMENTS = 2;

  // FAST segment detection - check every 500ms
  const checkSegmentsReady = () => {
    try {
      const masterPath = path.join(outputDir, `master_${slotId}.m3u8`);
      const streamPath = path.join(outputDir, `stream_${slotId}.m3u8`);
      
      if (!fs.existsSync(masterPath) || !fs.existsSync(streamPath)) {
        return false;
      }
      
      const masterStats = fs.statSync(masterPath);
      const streamStats = fs.statSync(streamPath);
      if (masterStats.size === 0 || streamStats.size === 0) {
        return false;
      }
      
      const streamContent = fs.readFileSync(streamPath, 'utf8');
      const segmentMatches = streamContent.match(/segment_.*?\.ts/g);
      
      if (!segmentMatches || segmentMatches.length < REQUIRED_SEGMENTS) {
        return false;
      }
      
      let validSegments = 0;
      for (const segName of segmentMatches.slice(0, REQUIRED_SEGMENTS)) {
        const segPath = path.join(outputDir, segName);
        if (fs.existsSync(segPath)) {
          const stats = fs.statSync(segPath);
          if (stats.size > 5000) {  // At least 5KB
            validSegments++;
          }
        }
      }
      
      return validSegments >= REQUIRED_SEGMENTS;
    } catch (e) {
      return false;
    }
  };

  // Check every 500ms (faster detection)
  segmentCheckInterval = setInterval(() => {
    if (!isReady && checkSegmentsReady()) {
      isReady = true;
      clearInterval(segmentCheckInterval);
      clearTimeout(readyCheckTimeout);
      console.log(`✅ [${channelId}-${slotId}] Stream ready with ${REQUIRED_SEGMENTS}+ playable segments!`);
      if (onReady) onReady();
    }
  }, 500);  // Changed from 1500ms to 500ms

  // 20 second timeout (should be enough with optimized settings)
  readyCheckTimeout = setTimeout(() => {
    clearInterval(segmentCheckInterval);
    if (!isReady) {
      console.log(`❌ [${channelId}-${slotId}] Ready timeout - no playable segments found`);
      if (checkSegmentsReady()) {
        isReady = true;
        if (onReady) onReady();
      }
    }
  }, 20000);  // Changed from 45000ms to 20000ms

  proc.stderr.on('data', data => {
    const output = data.toString();
    
    if (output.toLowerCase().includes('error') || output.toLowerCase().includes('invalid')) {
      console.error(`❌ [${channelId}-${slotId}] FFmpeg error:`, output.substring(0, 200));
    }

    if (output.includes('frame=')) {
      const frameMatch = output.match(/frame=\s*(\d+)/);
      if (frameMatch && parseInt(frameMatch[1]) % 300 === 0) {
        console.log(`[${channelId}-${slotId}] Frame ${frameMatch[1]}`);
      }
    }
  });

  proc.on('exit', (code) => {
    clearTimeout(readyCheckTimeout);
    clearInterval(segmentCheckInterval);
    console.log(`🔴 [${channelId}] FFmpeg slot ${slotId} exited with code ${code}`);
    if (onExit) onExit(code);
  });

  proc.on('error', (error) => {
    clearTimeout(readyCheckTimeout);
    clearInterval(segmentCheckInterval);
    console.error(`❌ [${channelId}-${slotId}] FFmpeg process error:`, error);
    if (onExit) onExit(-1);
  });

  return proc;
}

function switchActiveStream(channelOutput, toSlot) {
  const masterLink = path.join(channelOutput, 'master.m3u8');
  const streamLink = path.join(channelOutput, 'stream.m3u8');
  const targetMaster = path.join(channelOutput, `master_${toSlot}.m3u8`);
  const targetStream = path.join(channelOutput, `stream_${toSlot}.m3u8`);

  try {
    // Verify target files exist and are readable
    if (!fs.existsSync(targetMaster) || !fs.existsSync(targetStream)) {
      console.log(`⚠️ Target files not ready for slot ${toSlot} (files don't exist)`);
      return false;
    }

    // Verify target files have content
    const masterStats = fs.statSync(targetMaster);
    const streamStats = fs.statSync(targetStream);
    
    if (masterStats.size === 0 || streamStats.size === 0) {
      console.log(`⚠️ Target files empty for slot ${toSlot}`);
      return false;
    }

    // Verify stream playlist has actual segments listed
    let streamContent;
    try {
      streamContent = fs.readFileSync(targetStream, 'utf8');
      if (!streamContent.includes('.ts')) {
        console.log(`⚠️ No segments in playlist for slot ${toSlot}`);
        return false;
      }
    } catch (e) {
      console.log(`⚠️ Cannot read stream playlist for slot ${toSlot}:`, e.message);
      return false;
    }

    // Verify at least 2 actual segment files exist
    const segmentMatches = streamContent.match(new RegExp(`segment_${toSlot}_\\d+\\.ts`, 'g'));
    if (!segmentMatches || segmentMatches.length < 2) {
      console.log(`⚠️ Not enough segments for slot ${toSlot} (found ${segmentMatches?.length || 0})`);
      return false;
    }

    // Verify segments are on disk and have data
    let validSegments = 0;
    for (const segName of segmentMatches.slice(0, 3)) { // Check first 3
      const segPath = path.join(channelOutput, segName);
      if (fs.existsSync(segPath) && fs.statSync(segPath).size > 5000) {
        validSegments++;
      }
    }

    if (validSegments < 2) {
      console.log(`⚠️ Not enough valid segments for slot ${toSlot} (${validSegments} valid)`);
      return false;
    }

    // Remove old links/files
    [masterLink, streamLink].forEach(link => {
      try {
        if (fs.existsSync(link)) {
          fs.unlinkSync(link);
        }
      } catch (e) {
        console.error(`Warning: Could not remove ${link}:`, e.message);
      }
    });

    // Copy files (more reliable than symlinks)
    fs.copyFileSync(targetMaster, masterLink);
    fs.copyFileSync(targetStream, streamLink);

    console.log(`🔄 Successfully switched to slot ${toSlot} (${validSegments} segments verified)`);
    return true;
  } catch (error) {
    console.error(`❌ Error switching streams:`, error.message);
    return false;
  }
}
// ==================== CHANNEL MANAGEMENT ====================

function getChannelOutput(channelId) {
  return path.join(baseOutputDir, channelId);
}

async function playAd(channelId) {
  const state = channelStates[channelId];
  const channelOutput = getChannelOutput(channelId);

  // FIXED: Don't start ad if movies are in queue
  if (channels[channelId].queue && channels[channelId].queue.length > 0) {
    console.log(`📺 [${channelId}] Queue has movies, not starting ad`);
    return;
  }

  if (state.isPlaying || state.playingAd) return;

  // Check if ad file exists
  if (!fs.existsSync(adVideoPath)) {
    console.error(`❌ [${channelId}] Ad file not found at ${adVideoPath}`);
    setTimeout(() => playAd(channelId), 5000);
    return;
  }

  console.log(`📺 [${channelId}] Starting Ad Loop in slot ${state.activeSlot}`);
  state.isPlaying = true;
  state.playingAd = true;

  if (state.currentProcess) {
    state.currentProcess.kill('SIGKILL');
    state.currentProcess = null;
  }

  state.currentProcess = startFFmpeg(
  channelId,
  adVideoPath,
  channelOutput,
  'Ad',
  state.activeSlot,
  (exitCode) => {
    state.isPlaying = false;
    console.log(`✅ [${channelId}] Ad loop exited (${exitCode})`);
    
    const hasMovies = channels[channelId].queue && channels[channelId].queue.length > 0;
    
    if (hasMovies) {
      console.log(`📺 [${channelId}] Queue has movies, not restarting ad`);
      state.playingAd = false;
      setTimeout(() => playNextMovie(channelId), 1000);
      return;
    }
    
    if (!hasMovies && exitCode !== -1) {
      setTimeout(() => playAd(channelId), 1000);
    } else if (exitCode === -1) {
      console.error(`❌ [${channelId}] Ad FFmpeg failed, waiting before retry...`);
      setTimeout(() => playAd(channelId), 5000);
    }
  },
  async () => { // Make this async
    // Wait a bit longer before switching to ensure segments are stable
    await new Promise(resolve => setTimeout(resolve, 3000));
    const switched = switchActiveStream(channelOutput, state.activeSlot);
    if (switched) {
      console.log(`🟢 [${channelId}] Ad loop ready and streaming`);
    } else {
      console.error(`❌ [${channelId}] Ad failed to switch streams, retrying...`);
      // Retry switch after delay
      setTimeout(() => {
        if (switchActiveStream(channelOutput, state.activeSlot)) {
          console.log(`🟢 [${channelId}] Ad loop ready after retry`);
        }
      }, 2000);
    }
  },
  true
);
}
// ==================== IMPROVED PRELOAD & PLAYBACK ====================

async function preloadNextMovie(channelId) {
  const state = channelStates[channelId];
  const channelConfig = channels[channelId];
  const channelOutput = getChannelOutput(channelId);
  
  if (!channelConfig.queue || channelConfig.queue.length === 0) {
    console.log(`📺 [${channelId}] No movies in queue to preload`);
    return false;
  }

  if (state.isPreloading) {
    console.log(`⚠️ [${channelId}] Preload already in progress, skipping`);
    return false;
  }

  if (state.preloadReady) {
    console.log(`✅ [${channelId}] Movie already preloaded`);
    return true;
  }

  const nextMovie = channelConfig.queue[0];
  
  if (!nextMovie || !nextMovie.filePath) {
    console.error(`❌ [${channelId}] Invalid movie in queue for preload`);
    return false;
  }

  if (!fs.existsSync(nextMovie.filePath)) {
    console.error(`❌ [${channelId}] Movie file not found: ${nextMovie.filePath}`);
    return false;
  }

  console.log(`🔄 [${channelId}] Preloading "${nextMovie.title}" in slot ${state.nextSlot}`);

  state.preloadReady = false;
  state.isPreloading = true;

  return new Promise((resolve) => {
    let resolved = false;
    
    const resolveOnce = (value) => {
      if (!resolved) {
        resolved = true;
        state.isPreloading = false;
        resolve(value);
      }
    };

    state.nextProcess = startFFmpeg(
      channelId,
      nextMovie.filePath,
      channelOutput,
      nextMovie.title,
      state.nextSlot,
      (exitCode) => {
        console.log(`✅ [${channelId}] Movie "${nextMovie.title}" finished (${exitCode})`);
        state.nextProcess = null;
        state.isPlaying = false;
        state.isPreloading = false;
        
        // CRITICAL FIX: Don't check queue here - it will be shifted later
        setTimeout(() => playNextMovie(channelId), 2000);
      },
      () => {
        console.log(`🟢 [${channelId}] Movie "${nextMovie.title}" preloaded and ready!`);
        state.preloadReady = true;
        resolveOnce(true);
      },
      false
    );

    if (!state.nextProcess) {
      console.error(`❌ [${channelId}] Failed to start FFmpeg process`);
      state.isPreloading = false;
      resolveOnce(false);
      return;
    }

    // Reduced timeout to 25 seconds
    setTimeout(() => {
      if (!state.preloadReady) {
        console.log(`⏰ [${channelId}] Preload timeout, verifying manually...`);
        const masterPath = path.join(channelOutput, `master_${state.nextSlot}.m3u8`);
        const streamPath = path.join(channelOutput, `stream_${state.nextSlot}.m3u8`);
        
        if (fs.existsSync(masterPath) && fs.existsSync(streamPath)) {
          try {
            const content = fs.readFileSync(streamPath, 'utf8');
            const segments = content.match(/segment_.*?\.ts/g);
            if (segments && segments.length >= 2) {
              let validCount = 0;
              for (const seg of segments.slice(0, 2)) {
                const segPath = path.join(channelOutput, seg);
                if (fs.existsSync(segPath) && fs.statSync(segPath).size > 5000) {
                  validCount++;
                }
              }
              
              if (validCount >= 2) {
                console.log(`✅ [${channelId}] Manual verification passed`);
                state.preloadReady = true;
                resolveOnce(true);
                return;
              }
            }
          } catch (e) {
            console.error(`❌ [${channelId}] Manual verification error:`, e.message);
          }
        }
        
        console.error(`❌ [${channelId}] Preload verification failed - no valid segments`);
        resolveOnce(false);
      }
    }, 25000);  // Changed from 50000ms to 25000ms
  });
}

// ==================== CRITICAL FIX: playNextMovie ====================

async function playNextMovie(channelId) {
  const state = channelStates[channelId];
  const channelConfig = channels[channelId];
  const channelOutput = getChannelOutput(channelId);

  // FIRST: Check if queue is empty
  if (!channelConfig.queue || channelConfig.queue.length === 0) {
    console.log(`📺 [${channelId}] Queue empty, returning to ad loop`);
    state.playingAd = false;
    state.isPlaying = false;
    state.preloadReady = false;
    
    if (state.currentProcess) {
      state.currentProcess.kill('SIGKILL');
      state.currentProcess = null;
    }
    
    setTimeout(() => playAd(channelId), 1000);
    return;
  }

  // Get movie reference BEFORE any operations
  const movie = channelConfig.queue[0];
  
  if (!movie || !movie.title || !movie.filePath) {
    console.error(`❌ [${channelId}] Invalid movie object in queue!`);
    channelConfig.queue.shift();
    fs.writeFileSync(channelsFile, JSON.stringify(channels, null, 2));
    state.preloadReady = false;
    setTimeout(() => playNextMovie(channelId), 1000);
    return;
  }

  const movieTitle = movie.title;
  const movieFilePath = movie.filePath;

  // If preload not ready, force it now
  if (!state.preloadReady) {
    console.log(`⏳ [${channelId}] Movie not preloaded, forcing preload...`);
    
    if (state.nextProcess) {
      console.log(`⚠️ [${channelId}] Preload already in progress, waiting...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      if (!state.preloadReady) {
        console.error(`❌ [${channelId}] Preload still not ready after wait`);
        setTimeout(() => playNextMovie(channelId), 5000);
        return;
      }
    } else {
      const preloaded = await preloadNextMovie(channelId);
      
      if (!preloaded || !state.preloadReady) {
        console.error(`❌ [${channelId}] Failed to preload movie, retrying in 5s...`);
        setTimeout(() => playNextMovie(channelId), 5000);
        return;
      }
    }
  }

  console.log(`🎬 [${channelId}] Now playing "${movieTitle}"`);

  // Swap slots
  const oldSlot = state.activeSlot;
  state.activeSlot = state.nextSlot;
  state.nextSlot = oldSlot;

  // Kill ad if playing
  if (state.playingAd && state.currentProcess) {
    state.currentProcess.kill('SIGKILL');
  }

  // Move next process to current
  state.currentProcess = state.nextProcess;
  state.nextProcess = null;
  state.playingAd = false;
  state.isPlaying = true;
  state.preloadReady = false;

  // Switch stream with retries
  let switched = false;
  for (let i = 0; i < 3; i++) {
    switched = switchActiveStream(channelOutput, state.activeSlot);
    if (switched) break;
    console.log(`⏳ [${channelId}] Switch attempt ${i + 1}/3 failed, retrying...`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (!switched) {
    console.error(`❌ [${channelId}] Failed to switch streams after 3 attempts!`);
  }

  // Update metadata
  const duration = await getVideoDuration(movieFilePath);
  const startTime = new Date();
  const endTime = new Date(startTime.getTime() + duration);

  channelConfig.currentMovie = movieTitle;
  channelConfig.currentStartTime = startTime;
  channelConfig.currentEndTime = endTime;
  
  channelConfig.schedule = await generateDynamicSchedule(channelId, channelConfig, {
    title: movieTitle,
    startTime: startTime,
    endTime: endTime
  });

  // CRITICAL: Remove from queue AFTER everything is set up
  channelConfig.queue.shift();
  fs.writeFileSync(channelsFile, JSON.stringify(channels, null, 2));

  // Preload next movie if available
  if (channelConfig.queue.length > 0) {
    setTimeout(async () => {
      if (!state.nextProcess && !state.preloadReady) {
        await preloadNextMovie(channelId);
      }
    }, 10000);  // Reduced from 15000ms to 10000ms
  }
}
async function initializeChannel(channelId) {
  const channelConfig = channels[channelId];
  const channelOutput = getChannelOutput(channelId);

  // Create output directory
  if (fs.existsSync(channelOutput)) {
    fs.rmSync(channelOutput, { recursive: true, force: true });
  }
  fs.mkdirSync(channelOutput, { recursive: true });

  // Initialize state
channelStates[channelId] = {
  currentProcess: null,
  nextProcess: null,
  activeSlot: 'A',
  nextSlot: 'B',
  isPlaying: false,
  playingAd: false,
  preloadReady: false,
  isPreloading: false // ADD THIS
};

  // Setup HLS serving
  app.use(`/hls/${channelId}`, express.static(channelOutput));

  // Check if there are movies in queue
  if (channelConfig.queue && channelConfig.queue.length > 0) {
    console.log(`📺 [${channelId}] Queue has ${channelConfig.queue.length} movies, preloading first movie`);
    const preloaded = await preloadNextMovie(channelId);
    
    // FIXED: Always try to play movie after preload
    if (preloaded) {
      // Wait a bit for segments to be ready
      setTimeout(() => {
        if (channelStates[channelId].preloadReady) {
          playNextMovie(channelId);
        } else {
          console.log(`📺 [${channelId}] Preload not ready yet, waiting...`);
          // Retry after delay
          setTimeout(() => playNextMovie(channelId), 3000);
        }
      }, 2000);
    } else {
      console.log(`📺 [${channelId}] Preload failed, starting ad loop`);
      playAd(channelId);
    }
  } else {
    console.log(`📺 [${channelId}] No movies in queue, starting ad loop`);
    playAd(channelId);
  }
}

// ==================== TELEGRAM BOT HANDLERS ====================

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `🎬 *Welcome to AnitakuX Movie Streaming Bot!*\n\n` +
    `*Commands:*\n` +
    `/play <movie name> - Reply to a video/document\n` +
    `/play <movie name>|<url> - Add from direct link\n` +
    `/queue - View current queue\n` +
    `/channels - List all channels\n` +
    `/status - Check streaming status\n\n` +
    `*How to use:*\n` +
    `1. Add me to a group to create a channel\n` +
    `2. Use /play to add movies\n` +
    `3. Watch live at your channel URL\n\n` +
    `*Supported formats:*\n` +
    `MP4, MKV, AVI, MOV, WEBM, FLV, WMV\n\n` +
    `*Supported sites:*\n` +
    `Catbox, Gofile, Pixeldrain, Google Drive, Dropbox, Mega, and more!\n\n` +
    `The channel loops ads when queue is empty for 24/7 streaming.`,
    { parse_mode: 'Markdown' }
  );
});

bot.on('message', async (msg) => {
  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
    const channelId = `channel_${msg.chat.id}`;
    const channelName = msg.chat.title;

    // Create channel if it doesn't exist
    if (!channels[channelId]) {
      channels[channelId] = {
        name: channelName,
        queue: [],
        schedule: [],
        currentMovie: null,
        currentStartTime: null,
        currentEndTime: null
      };
      fs.writeFileSync(channelsFile, JSON.stringify(channels, null, 2));
      
      await initializeChannel(channelId);
      console.log(`📺 Created new channel: ${channelName} (${channelId})`);
      
      bot.sendMessage(msg.chat.id, 
        `✅ Channel "${channelName}" created!\n\n` +
        `Watch live: https://axstream.onrender.com/watch/${channelId}\n\n` +
        `Use /play command to add movies!`
      );
    }
  }
});

// Helper function to download from various sources
async function downloadVideo(url, filePath, onProgress) {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
  ];

  const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
  
  const headers = {
    'User-Agent': randomUserAgent,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Referer': url,
    'Origin': new URL(url).origin
  };

  // Special handling for known sites
  if (url.includes('catbox')) {
    headers['Referer'] = 'https://catbox.moe/';
  } else if (url.includes('gofile')) {
    headers['Referer'] = 'https://gofile.io/';
  } else if (url.includes('pixeldrain')) {
    headers['Referer'] = 'https://pixeldrain.com/';
  } else if (url.includes('mega.nz')) {
    headers['Referer'] = 'https://mega.nz/';
  } else if (url.includes('drive.google.com')) {
    // Extract Google Drive file ID and use direct download link
    const fileIdMatch = url.match(/[-\w]{25,}/);
    if (fileIdMatch) {
      url = `https://drive.google.com/uc?export=download&id=${fileIdMatch[0]}`;
    }
  } else if (url.includes('dropbox.com')) {
    // Force Dropbox direct download
    url = url.replace('www.dropbox.com', 'dl.dropboxusercontent.com').replace('?dl=0', '').replace('?dl=1', '');
  }

  const writer = fs.createWriteStream(filePath);
  let downloadedBytes = 0;

  try {
    const response = await axios({
      url: url,
      method: 'GET',
      responseType: 'stream',
      headers: headers,
      maxRedirects: 5,
      timeout: 30000,
      validateStatus: (status) => status < 400
    });

    const totalBytes = parseInt(response.headers['content-length'], 10);

    response.data.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      if (onProgress && totalBytes) {
        const progress = ((downloadedBytes / totalBytes) * 100).toFixed(1);
        onProgress(progress, downloadedBytes, totalBytes);
      }
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
      response.data.on('error', reject);
    });
  } catch (error) {
    // Clean up failed download
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    throw error;
  }
}

// Helper to detect file extension from URL or headers
function getFileExtension(url, contentType) {
  // Try to get from URL first
  const urlMatch = url.match(/\.(mp4|mkv|avi|mov|webm|flv|wmv|m4v)(\?|$)/i);
  if (urlMatch) return urlMatch[1].toLowerCase();

  // Try from content-type
  if (contentType) {
    if (contentType.includes('mp4')) return 'mp4';
    if (contentType.includes('mkv') || contentType.includes('matroska')) return 'mkv';
    if (contentType.includes('avi')) return 'avi';
    if (contentType.includes('quicktime')) return 'mov';
    if (contentType.includes('webm')) return 'webm';
  }

  // Default to mp4
  return 'mp4';
}

bot.onText(/\/play (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1].trim();

  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
    return bot.sendMessage(chatId, '❌ This command only works in groups!');
  }

  const channelId = `channel_${chatId}`;
  
  if (!channels[channelId]) {
    return bot.sendMessage(chatId, '❌ Channel not initialized. Please wait...');
  }

  let movieName, movieUrl, downloadSource;

  // Check if input contains pipe separator for name|url format
  if (input.includes('|')) {
    const parts = input.split('|').map(p => p.trim());
    movieName = parts[0];
    movieUrl = parts[1];
    downloadSource = 'url';
  } 
  // Check if replying to a message with video
  else if (msg.reply_to_message) {
    const replyMsg = msg.reply_to_message;
    const video = replyMsg.video || replyMsg.document;
    
    if (!video) {
      return bot.sendMessage(chatId, '❌ Reply must contain a video or document, or use format: /play Movie Name|URL');
    }
    
    movieName = input;
    downloadSource = 'telegram';
  } 
  else {
    return bot.sendMessage(chatId, 
      '❌ Invalid format!\n\n' +
      '*Usage:*\n' +
      '• `/play Movie Name` (reply to video)\n' +
      '• `/play Movie Name|https://example.com/video.mp4`\n\n' +
      '*Supported sites:*\n' +
      'Direct links (.mp4, .mkv, .avi, etc.)\n' +
      'Catbox, Gofile, Pixeldrain, Google Drive, Dropbox, Mega, and more!',
      { parse_mode: 'Markdown' }
    );
  }

  if (!movieName || movieName.length === 0) {
    return bot.sendMessage(chatId, '❌ Movie name cannot be empty!');
  }

  try {
    const statusMsg = await bot.sendMessage(chatId, `⏳ Preparing "${movieName}"...`);

    const moviesDir = path.join(__dirname, 'movies', channelId);
    if (!fs.existsSync(moviesDir)) fs.mkdirSync(moviesDir, { recursive: true });

    let filePath;
    let fileExtension = 'mp4';

    // Download from URL
    if (downloadSource === 'url') {
      // Validate URL
      try {
        new URL(movieUrl);
      } catch (e) {
        bot.editMessageText('❌ Invalid URL provided!', {
          chat_id: chatId,
          message_id: statusMsg.message_id
        });
        return;
      }

      bot.editMessageText(`⏳ Downloading "${movieName}" from URL...`, {
        chat_id: chatId,
        message_id: statusMsg.message_id
      });

      // Try to get file extension from URL
      try {
        const headResponse = await axios.head(movieUrl, {
          timeout: 5000,
          maxRedirects: 5
        });
        fileExtension = getFileExtension(movieUrl, headResponse.headers['content-type']);
      } catch (e) {
        fileExtension = getFileExtension(movieUrl, null);
      }

      const fileName = `${Date.now()}_${movieName.substring(0, 50).replace(/[^a-z0-9]/gi, '_')}.${fileExtension}`;
      filePath = path.join(moviesDir, fileName);

      let lastProgress = 0;
      await downloadVideo(movieUrl, filePath, (progress, downloaded, total) => {
        // Update progress every 10%
        if (Math.floor(progress / 10) > Math.floor(lastProgress / 10)) {
          const downloadedMB = (downloaded / (1024 * 1024)).toFixed(1);
          const totalMB = (total / (1024 * 1024)).toFixed(1);
          bot.editMessageText(
            `⏳ Downloading "${movieName}"...\n\n` +
            `Progress: ${progress}%\n` +
            `Downloaded: ${downloadedMB}MB / ${totalMB}MB`,
            {
              chat_id: chatId,
              message_id: statusMsg.message_id
            }
          ).catch(() => {}); // Ignore edit errors
          lastProgress = progress;
        }
      });
    } 
    // Download from Telegram
    else {
      const replyMsg = msg.reply_to_message;
      const video = replyMsg.video || replyMsg.document;

      bot.editMessageText(`⏳ Downloading "${movieName}" from Telegram...`, {
        chat_id: chatId,
        message_id: statusMsg.message_id
      });

      const fileId = video.file_id;
      const file = await bot.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;

      // Get extension from file path
      fileExtension = getFileExtension(file.file_path, video.mime_type);

      const fileName = `${Date.now()}_${movieName.replace(/[^a-z0-9]/gi, '_')}.${fileExtension}`;
      filePath = path.join(moviesDir, fileName);

      const writer = fs.createWriteStream(filePath);
      const response = await axios({
        url: fileUrl,
        method: 'GET',
        responseType: 'stream'
      });

      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
    }

    // Verify file exists and has size
    const stats = fs.statSync(filePath);
    if (stats.size === 0) {
      throw new Error('Downloaded file is empty');
    }

    bot.editMessageText(`⏳ "${movieName}" downloaded! Verifying file...`, {
      chat_id: chatId,
      message_id: statusMsg.message_id
    });

    // Verify video file is valid using ffprobe
    try {
      await getVideoDuration(filePath);
    } catch (error) {
      fs.unlinkSync(filePath);
      throw new Error('Invalid video file format');
    }

    // Add to queue
    channels[channelId].queue.push({
      title: movieName,
      filePath: filePath,
      addedBy: msg.from.username || msg.from.first_name,
      addedAt: new Date(),
      fileSize: stats.size,
      format: fileExtension
    });

    // Regenerate schedule immediately when movie is added
    const currentInfo = channels[channelId].currentStartTime ? {
      title: channels[channelId].currentMovie,
      startTime: new Date(channels[channelId].currentStartTime),
      endTime: new Date(channels[channelId].currentEndTime)
    } : null;
    channels[channelId].schedule = await generateDynamicSchedule(channelId, channels[channelId], currentInfo);

    fs.writeFileSync(channelsFile, JSON.stringify(channels, null, 2));

    const state = channelStates[channelId];
    const isFirstMovie = channels[channelId].queue.length === 1;

// If this is the first movie and ad is playing, switch to it
if (isFirstMovie && state && state.playingAd) {
  bot.editMessageText(
    `⏳ "${movieName}" downloaded! Preparing to stream...`,
    { chat_id: chatId, message_id: statusMsg.message_id }
  );
  
  // STEP 1: Stop ad completely
  if (state.currentProcess) {
    console.log(`🛑 [${channelId}] Stopping ad for first movie`);
    try {
      state.currentProcess.kill('SIGKILL');
    } catch (e) {
      console.log(`⚠️ [${channelId}] Error killing ad process:`, e.message);
    }
    state.currentProcess = null;
  }
  
  state.playingAd = false;
  state.isPlaying = false;
  state.preloadReady = false;
  state.isPreloading = false;
  
  // STEP 2: Wait for ad process to fully terminate
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // STEP 3: Clean up old segment files from ad
  try {
    const channelOutput = getChannelOutput(channelId);
    const files = fs.readdirSync(channelOutput);
    files.forEach(file => {
      if (file.includes('segment_') || file.includes('stream_') || file.includes('master_')) {
        try {
          fs.unlinkSync(path.join(channelOutput, file));
        } catch (e) {}
      }
    });
  } catch (e) {
    console.log(`⚠️ [${channelId}] Error cleaning segments:`, e.message);
  }
  
  // STEP 4: Wait a bit more
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // STEP 5: Start fresh preload
  console.log(`🔄 [${channelId}] Preloading first movie`);
  
  const preloadSuccess = await preloadNextMovie(channelId);
  
  if (!preloadSuccess || !state.preloadReady) {
    bot.sendMessage(chatId, `⚠️ "${movieName}" added but failed to preload. It will retry automatically in 10 seconds.`);
    setTimeout(() => playNextMovie(channelId), 10000);
    return;
  }
  
  // STEP 6: Wait for segments to stabilize
  console.log(`⏳ [${channelId}] Waiting for segments to stabilize...`);
  await new Promise(resolve => setTimeout(resolve, 8000));
  
  // STEP 7: Verify segments are really ready
  const channelOutput = getChannelOutput(channelId);
  const streamPath = path.join(channelOutput, `stream_${state.nextSlot}.m3u8`);
  
  let segmentsReady = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      if (fs.existsSync(streamPath)) {
        const streamContent = fs.readFileSync(streamPath, 'utf8');
        const segmentMatches = streamContent.match(/segment_.*?\.ts/g);
        
        if (segmentMatches && segmentMatches.length >= 2) {
          let validCount = 0;
          for (const seg of segmentMatches.slice(0, 3)) {
            const segPath = path.join(channelOutput, seg);
            if (fs.existsSync(segPath) && fs.statSync(segPath).size > 5000) {
              validCount++;
            }
          }
          
          if (validCount >= 2) {
            segmentsReady = true;
            console.log(`✅ [${channelId}] Found ${validCount} valid segments`);
            break;
          }
        }
      }
    } catch (e) {
      console.error(`⚠️ [${channelId}] Segment check error:`, e.message);
    }
    
    console.log(`⏳ [${channelId}] Waiting for segments... (${attempt + 1}/8)`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  if (!segmentsReady) {
    bot.sendMessage(chatId, `⚠️ "${movieName}" added but segments not ready. Will retry in 15s.`);
    setTimeout(() => playNextMovie(channelId), 15000);
    return;
  }
  
  // STEP 8: Now play
  console.log(`✅ [${channelId}] Everything ready, starting playback`);
  await playNextMovie(channelId);
  
  bot.sendMessage(chatId, 
    `🎬 Now playing "${movieName}"!\n\n` +
    `Format: ${fileExtension.toUpperCase()}\n` +
    `Size: ${(stats.size / (1024 * 1024)).toFixed(1)}MB\n\n` +
    `Watch: https://axstream.onrender.com/watch/${channelId}`
  );
} else {
  bot.editMessageText(
    `✅ Added "${movieName}" to queue!\n\n` +
    `Position: ${channels[channelId].queue.length}\n` +
    `Format: ${fileExtension.toUpperCase()}\n` +
    `Size: ${(stats.size / (1024 * 1024)).toFixed(1)}MB\n\n` +
    `Watch: https://axstream.onrender.com/watch/${channelId}`,
    { chat_id: chatId, message_id: statusMsg.message_id }
  );
}

  } catch (error) {
    console.error('Error processing video:', error);
    bot.sendMessage(chatId, 
      `❌ Error downloading video!\n\n` +
      `Error: ${error.message}\n\n` +
      `Please check:\n` +
      `• URL is valid and accessible\n` +
      `• File is a valid video format\n` +
      `• Server has enough storage space`
    );
  }
});

bot.onText(/\/queue/, (msg) => {
  const chatId = msg.chat.id;

  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
    return bot.sendMessage(chatId, '❌ This command only works in groups!');
  }

  const channelId = `channel_${chatId}`;
  const channel = channels[channelId];

  if (!channel) {
    return bot.sendMessage(chatId, '❌ Channel not found!');
  }

  let queueText = `📺 *${channel.name} Queue*\n\n`;
  
  if (channel.currentMovie) {
    queueText += `🎬 *Now Playing:* ${channel.currentMovie}\n\n`;
  } else {
    queueText += `📢 *Now Playing:* Advertisement Loop\n\n`;
  }

  if (channel.queue.length === 0) {
    queueText += `*Queue is empty!*\nUse /play to add movies.`;
  } else {
    queueText += `*Up Next (${channel.queue.length} movies):*\n`;
    channel.queue.forEach((movie, index) => {
      const addedBy = movie.addedBy ? `by @${movie.addedBy}` : '';
      queueText += `${index + 1}. ${movie.title} ${addedBy}\n`;
    });
  }

  bot.sendMessage(chatId, queueText, { parse_mode: 'Markdown' });
});

// Find this section around line 780-810 and replace it:

bot.onText(/\/channels/, (msg) => {
  const chatId = msg.chat.id;

  if (Object.keys(channels).length === 0) {
    return bot.sendMessage(chatId, '📺 No channels available. Add me to a group to create one!');
  }

  let channelText = `📺 *Available Channels*\n\n`;
  Object.entries(channels).forEach(([id, config]) => {
    const state = channelStates[id];
    const queueCount = config.queue ? config.queue.length : 0;
    const status = config.currentMovie || (state?.playingAd ? '📢 Ad Loop' : 'Starting...');
    const liveIndicator = state?.isPlaying ? '🟢' : '🔴';
    
    channelText += `${liveIndicator} *${config.name}*\n`;
    channelText += `   Now: ${status}\n`;
    channelText += `   Queue: ${queueCount} movies\n`;
    channelText += `   Watch: https://axstream.onrender.com/watch/${id}\n\n`;
  });

  bot.sendMessage(chatId, channelText, { parse_mode: 'Markdown' });
}); // <-- THIS CLOSING BRACE WAS MISSING!

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;

  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
    return bot.sendMessage(chatId, '❌ This command only works in groups!');
  }

  const channelId = `channel_${chatId}`;
  const channel = channels[channelId];

  if (!channel) {
    return bot.sendMessage(chatId, '❌ Channel not found!');
  }

  const state = channelStates[channelId];
  const isLive = state && state.isPlaying;
  const streamStatus = state && state.playingAd ? '📢 Ad Loop' : '🎬 Movie';

  let statusText = `📺 *${channel.name} Status*\n\n`;
  statusText += `*Stream Status:* ${isLive ? '🟢 Live' : '🔴 Offline'}\n`;
  statusText += `*Currently Playing:* ${channel.currentMovie || streamStatus}\n`;
  statusText += `*Queue Length:* ${channel.queue?.length || 0} movies\n\n`;

  if (channel.currentMovie && channel.currentStartTime && channel.currentEndTime) {
    const now = new Date();
    const endTime = new Date(channel.currentEndTime);
    const remainingMs = endTime - now;
    const remainingMin = Math.max(0, Math.floor(remainingMs / 60000));
    
    statusText += `*Time Remaining:* ${remainingMin} minutes\n`;
    statusText += `*Ends At:* ${formatWATTime(endTime)}\n\n`;
  }

  statusText += `*Watch Live:*\n`;
  statusText += `https://axstream.onrender.com/watch/${channelId}\n\n`;
  statusText += `_Real-time schedule updates • Seamless transitions_`;

  bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
});
// ==================== API ROUTES ====================

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>AnitakuX - Live Streaming</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background: #000000;
          color: #ffffff;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .container {
          max-width: 900px;
          width: 100%;
          text-align: center;
        }
        .logo {
          font-size: 3rem;
          font-weight: 900;
          background: linear-gradient(45deg, #ff1493, #ff69b4, #ff1493);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          margin-bottom: 20px;
        }
        .subtitle {
          color: #ff69b4;
          font-size: 1.2rem;
          margin-bottom: 40px;
        }
        .channels-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
          gap: 20px;
          margin-top: 30px;
        }
        .channel-card {
          background: linear-gradient(135deg, rgba(255, 20, 147, 0.1) 0%, rgba(0, 0, 0, 0.8) 100%);
          border: 1px solid rgba(255, 20, 147, 0.3);
          border-radius: 12px;
          padding: 20px;
          text-decoration: none;
          transition: all 0.3s ease;
        }
        .channel-card:hover {
          transform: translateY(-5px);
          border-color: #ff1493;
          box-shadow: 0 8px 25px rgba(255, 20, 147, 0.4);
        }
        .channel-name {
          font-size: 1.3rem;
          font-weight: 700;
          color: #ff1493;
          margin-bottom: 10px;
        }
        .channel-status {
          font-size: 0.9rem;
          color: #ff69b4;
          margin-bottom: 5px;
        }
        .live-indicator {
          display: inline-block;
          width: 8px;
          height: 8px;
          background: #00ff00;
          border-radius: 50%;
          margin-right: 5px;
          animation: pulse 2s infinite;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        .watch-btn {
          display: inline-block;
          margin-top: 15px;
          padding: 10px 20px;
          background: linear-gradient(135deg, #ff1493 0%, #ff69b4 100%);
          border-radius: 20px;
          color: white;
          font-weight: 600;
          text-decoration: none;
          transition: all 0.2s ease;
        }
        .watch-btn:hover {
          box-shadow: 0 4px 15px rgba(255, 20, 147, 0.5);
        }
        .no-channels {
          color: #ff69b4;
          font-size: 1.1rem;
          padding: 30px;
          background: rgba(255, 20, 147, 0.1);
          border-radius: 12px;
          border: 1px solid rgba(255, 20, 147, 0.2);
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo">AnitakuX</div>
        <div class="subtitle">📺 Live 24/7 Movie Streaming</div>
        
        <div class="channels-grid" id="channelsGrid">
          <div class="no-channels">Loading channels...</div>
        </div>
      </div>
      
      <script>
        async function loadChannels() {
          try {
            const response = await fetch('/api/channels-public');
            const data = await response.json();
            const grid = document.getElementById('channelsGrid');
            
            if (Object.keys(data).length === 0) {
              grid.innerHTML = '<div class="no-channels">No channels available yet. Add the bot to a Telegram group to create one!</div>';
              return;
            }
            
            grid.innerHTML = '';
            Object.entries(data).forEach(([id, channel]) => {
              const card = document.createElement('a');
              card.href = '/watch/' + id;
              card.className = 'channel-card';
              card.innerHTML = \`
                <div class="channel-name">\${channel.name}</div>
                <div class="channel-status">
                  <span class="live-indicator"></span>
                  \${channel.currentMovie || '📢 Ad Loop'}
                </div>
                <div class="channel-status">Queue: \${channel.queueLength} movies</div>
                <span class="watch-btn">Watch Live →</span>
              \`;
              grid.appendChild(card);
            });
          } catch (error) {
            console.error('Failed to load channels:', error);
          }
        }
        
        loadChannels();
        setInterval(loadChannels, 10000); // Refresh every 10 seconds
      </script>
    </body>
    </html>
  `);
});

app.get('/watch/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  const filePath = path.join(publicDir, 'channel.html');
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Channel player not found. Please create public/channel.html');
  }
  
  // Read the HTML file
  let html = fs.readFileSync(filePath, 'utf8');
  
  // Inject channel data fetching script before the closing script tag
  const channelDataScript = `
    // Fetch channel name from backend
    async function loadChannelInfo() {
      try {
        const response = await fetch('/api/channel-info/' + channelId);
        const data = await response.json();
        document.getElementById('channelName').textContent = data.name;
      } catch (error) {
        console.error('Failed to load channel info:', error);
        document.getElementById('channelName').textContent = 'Channel ${channelId}';
      }
    }
    
    // Call after channelId is set
    const originalInitPlayer = initPlayer;
    initPlayer = function() {
      originalInitPlayer();
      loadChannelInfo();
    };
  `;
  
  // Insert before the closing </script> tag of the main script
  html = html.replace(
    'channelId = getChannelId();',
    `channelId = getChannelId();\n        ${channelDataScript}`
  );
  
  res.send(html);
});

app.get('/api/channels-public', (req, res) => {
  const channelData = {};
  for (const [channelId, config] of Object.entries(channels)) {
    const state = channelStates[channelId];
    channelData[channelId] = {
      name: config.name,
      currentMovie: config.currentMovie,
      queueLength: config.queue?.length || 0,
      isLive: state?.isPlaying || false
    };
  }
  res.json(channelData);
});

app.get('/api/schedule/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  if (!channels[channelId]) {
    return res.status(400).json({ error: 'Invalid channel ID' });
  }
  res.json(channels[channelId].schedule || []);
});

app.get('/api/channel-info/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  if (!channels[channelId]) {
    return res.status(400).json({ error: 'Invalid channel ID' });
  }
  
  const state = channelStates[channelId];
  res.json({
    name: channels[channelId].name,
    currentMovie: channels[channelId].currentMovie,
    isLive: state?.isPlaying || false,
    playingAd: state?.playingAd || false
  });
});

app.get('/api/status', (req, res) => {
  const status = {};
  for (const [channelId, config] of Object.entries(channels)) {
    const state = channelStates[channelId];
    status[channelId] = {
      name: config.name,
      currentMovie: config.currentMovie || 'Ad Loop',
      isPlaying: state?.isPlaying || false,
      playingAd: state?.playingAd || false,
      queueLength: config.queue?.length || 0,
      preloadReady: state?.preloadReady || false
    };
  }
  res.json(status);
});

app.get('/api/queue/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  if (!channels[channelId]) {
    return res.status(400).json({ error: 'Invalid channel ID' });
  }

  res.json({
    channelName: channels[channelId].name,
    currentMovie: channels[channelId].currentMovie || 'Ad Loop',
    queue: (channels[channelId].queue || []).map((movie, index) => ({
      position: index + 1,
      title: movie.title,
      addedBy: movie.addedBy || 'Unknown'
    }))
  });
});

// ==================== INITIALIZATION ====================

// Create necessary directories
[publicDir, path.join(__dirname, 'ad'), path.join(__dirname, 'movies')].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Initialize existing channels from saved data
(async () => {
  for (const [id, config] of Object.entries(channels)) {
    await initializeChannel(id);
  }
})();

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🤖 Telegram bot started`);
  console.log(`📺 Add bot to groups to create channels`);
  console.log(`\n🎬 Available commands:`);
  console.log(`   /play <movie> - Add movie to queue`);
  console.log(`   /queue - View queue`);
  console.log(`   /channels - List channels`);
});

