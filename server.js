const { spawn } = require('child_process');
const express = require('express');
const fs = require('fs');
const cors = require('cors');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

const PORT = process.env.PORT || 7860;

const app = express();

const baseOutputDir = path.join(__dirname, 'hls_output');
const publicDir = path.join(__dirname, 'public');
const adVideoPath = path.join(__dirname, 'ad', 'ad.mp4');
const watermarkText = 'AnitakuX';
const channelsFile = path.join(__dirname, 'channels.json');
const jobsFile = path.join(__dirname, 'jobs.json');

app.use(cors());
app.use(express.static(publicDir));
app.use(express.json());

// Global state
const channelStates = {};
let channels = {};
let jobs = {};

// Load data
try {
  channels = JSON.parse(fs.readFileSync(channelsFile));
} catch (err) {
  channels = {};
  fs.writeFileSync(channelsFile, JSON.stringify(channels, null, 2));
}

try {
  jobs = JSON.parse(fs.readFileSync(jobsFile));
} catch (err) {
  jobs = {};
  fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
}

// ==================== HELPER FUNCTIONS ====================

function formatWATTime(date) {
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Lagos'
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
  if (!fs.existsSync(inputPath)) {
    console.error(`❌ [${channelId}-${slotId}] Input file not found: ${inputPath}`);
    if (onExit) onExit(-1);
    return null;
  }

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
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-crf', '28',
    '-maxrate', '2M', '-bufsize', '4M',
    '-c:a', 'aac', '-b:a', '96k',
    '-g', '30',
    '-sc_threshold', '0',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
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
          if (stats.size > 5000) {
            validSegments++;
          }
        }
      }
      
      return validSegments >= REQUIRED_SEGMENTS;
    } catch (e) {
      return false;
    }
  };

  segmentCheckInterval = setInterval(() => {
    if (!isReady && checkSegmentsReady()) {
      isReady = true;
      clearInterval(segmentCheckInterval);
      clearTimeout(readyCheckTimeout);
      console.log(`✅ [${channelId}-${slotId}] Stream ready with ${REQUIRED_SEGMENTS}+ playable segments!`);
      if (onReady) onReady();
    }
  }, 500);

  readyCheckTimeout = setTimeout(() => {
    clearInterval(segmentCheckInterval);
    if (!isReady) {
      console.log(`❌ [${channelId}-${slotId}] Ready timeout - no playable segments found`);
      if (checkSegmentsReady()) {
        isReady = true;
        if (onReady) onReady();
      }
    }
  }, 20000);

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
    if (!fs.existsSync(targetMaster) || !fs.existsSync(targetStream)) {
      console.log(`⚠️ Target files not ready for slot ${toSlot} (files don't exist)`);
      return false;
    }

    const masterStats = fs.statSync(targetMaster);
    const streamStats = fs.statSync(targetStream);
    
    if (masterStats.size === 0 || streamStats.size === 0) {
      console.log(`⚠️ Target files empty for slot ${toSlot}`);
      return false;
    }

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

    const segmentMatches = streamContent.match(new RegExp(`segment_${toSlot}_\\d+\\.ts`, 'g'));
    if (!segmentMatches || segmentMatches.length < 2) {
      console.log(`⚠️ Not enough segments for slot ${toSlot} (found ${segmentMatches?.length || 0})`);
      return false;
    }

    let validSegments = 0;
    for (const segName of segmentMatches.slice(0, 3)) {
      const segPath = path.join(channelOutput, segName);
      if (fs.existsSync(segPath) && fs.statSync(segPath).size > 5000) {
        validSegments++;
      }
    }

    if (validSegments < 2) {
      console.log(`⚠️ Not enough valid segments for slot ${toSlot} (${validSegments} valid)`);
      return false;
    }

    [masterLink, streamLink].forEach(link => {
      try {
        if (fs.existsSync(link)) {
          fs.unlinkSync(link);
        }
      } catch (e) {
        console.error(`Warning: Could not remove ${link}:`, e.message);
      }
    });

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

  if (channels[channelId].queue && channels[channelId].queue.length > 0) {
    console.log(`📺 [${channelId}] Queue has movies, not starting ad`);
    return;
  }

  if (state.isPlaying || state.playingAd) return;

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
    async () => {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const switched = switchActiveStream(channelOutput, state.activeSlot);
      if (switched) {
        console.log(`🟢 [${channelId}] Ad loop ready and streaming`);
      } else {
        console.error(`❌ [${channelId}] Ad failed to switch streams, retrying...`);
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
    }, 25000);
  });
}

async function playNextMovie(channelId) {
  const state = channelStates[channelId];
  const channelConfig = channels[channelId];
  const channelOutput = getChannelOutput(channelId);

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

  const oldSlot = state.activeSlot;
  state.activeSlot = state.nextSlot;
  state.nextSlot = oldSlot;

  if (state.playingAd && state.currentProcess) {
    state.currentProcess.kill('SIGKILL');
  }

  state.currentProcess = state.nextProcess;
  state.nextProcess = null;
  state.playingAd = false;
  state.isPlaying = true;
  state.preloadReady = false;

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

  channelConfig.queue.shift();
  fs.writeFileSync(channelsFile, JSON.stringify(channels, null, 2));

  if (channelConfig.queue.length > 0) {
    setTimeout(async () => {
      if (!state.nextProcess && !state.preloadReady) {
        await preloadNextMovie(channelId);
      }
    }, 10000);
  }
}

async function initializeChannel(channelId) {
  const channelConfig = channels[channelId];
  const channelOutput = getChannelOutput(channelId);

  if (fs.existsSync(channelOutput)) {
    fs.rmSync(channelOutput, { recursive: true, force: true });
  }
  fs.mkdirSync(channelOutput, { recursive: true });

  channelStates[channelId] = {
    currentProcess: null,
    nextProcess: null,
    activeSlot: 'A',
    nextSlot: 'B',
    isPlaying: false,
    playingAd: false,
    preloadReady: false,
    isPreloading: false
  };

  app.use(`/hls/${channelId}`, express.static(channelOutput));

  if (channelConfig.queue && channelConfig.queue.length > 0) {
    console.log(`📺 [${channelId}] Queue has ${channelConfig.queue.length} movies, preloading first movie`);
    const preloaded = await preloadNextMovie(channelId);
    
    if (preloaded) {
      setTimeout(() => {
        if (channelStates[channelId].preloadReady) {
          playNextMovie(channelId);
        } else {
          console.log(`📺 [${channelId}] Preload not ready yet, waiting...`);
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

// ==================== JOB PROCESSING ====================

function updateJobStatus(jobId, status, data = {}) {
  if (jobs[jobId]) {
    jobs[jobId].status = status;
    jobs[jobId].updatedAt = new Date().toISOString();
    jobs[jobId] = { ...jobs[jobId], ...data };
    fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
  }
}

async function processAddMovieJob(jobId, jobData) {
  try {
    updateJobStatus(jobId, 'processing', { progress: 0 });
    
    const { channelId, movieName, filePath, addedBy, fileSize, format } = jobData;
    
    if (!fs.existsSync(filePath)) {
      throw new Error('File not found');
    }

    updateJobStatus(jobId, 'processing', { progress: 50, message: 'Verifying video...' });

    await getVideoDuration(filePath);

    if (!channels[channelId]) {
      throw new Error('Channel not found');
    }

    channels[channelId].queue.push({
      title: movieName,
      filePath: filePath,
      addedBy: addedBy,
      addedAt: new Date(),
      fileSize: fileSize,
      format: format
    });

    const currentInfo = channels[channelId].currentStartTime ? {
      title: channels[channelId].currentMovie,
      startTime: new Date(channels[channelId].currentStartTime),
      endTime: new Date(channels[channelId].currentEndTime)
    } : null;
    channels[channelId].schedule = await generateDynamicSchedule(channelId, channels[channelId], currentInfo);

    fs.writeFileSync(channelsFile, JSON.stringify(channels, null, 2));

    updateJobStatus(jobId, 'processing', { progress: 80, message: 'Checking playback...' });

    const state = channelStates[channelId];
    const isFirstMovie = channels[channelId].queue.length === 1;

    if (isFirstMovie && state && state.playingAd) {
      if (state.currentProcess) {
        state.currentProcess.kill('SIGKILL');
        state.currentProcess = null;
      }
      
      state.playingAd = false;
      state.isPlaying = false;
      state.preloadReady = false;
      state.isPreloading = false;
      
      await new Promise(resolve => setTimeout(resolve, 3000));
      
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
      } catch (e) {}
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      updateJobStatus(jobId, 'processing', { progress: 90, message: 'Starting playback...' });
      
      const preloadSuccess = await preloadNextMovie(channelId);
      
      if (!preloadSuccess || !state.preloadReady) {
        updateJobStatus(jobId, 'completed', { 
          progress: 100,
          message: 'Added to queue (will retry playback)',
          queuePosition: channels[channelId].queue.length,
          channelId,
          format
        });
        setTimeout(() => playNextMovie(channelId), 10000);
        return;
      }
      
      await new Promise(resolve => setTimeout(resolve, 8000));
      
      await playNextMovie(channelId);
      
      updateJobStatus(jobId, 'completed', { 
        progress: 100,
        message: 'Now playing!',
        isPlaying: true,
        channelId,
        format
      });
    } else {
      updateJobStatus(jobId, 'completed', { 
        progress: 100,
        message: 'Added to queue',
        queuePosition: channels[channelId].queue.length,
        channelId,
        format
      });
    }
  } catch (error) {
    console.error(`Job ${jobId} failed:`, error);
    updateJobStatus(jobId, 'failed', { error: error.message });
  }
}

// ==================== API ROUTES ====================

// Initialize channel
app.post('/api/channel/init', async (req, res) => {
  try {
    const { channelId, channelName } = req.body;
    
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
      
      setImmediate(() => initializeChannel(channelId));
    }
    
    res.json({ success: true, channelId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add movie (creates job, returns immediately)
app.post('/api/movie/add', async (req, res) => {
  try {
    const { channelId, movieName, filePath, addedBy, fileSize, format } = req.body;
    
    if (!channels[channelId]) {
      return res.status(400).json({ error: 'Channel not found' });
    }
    
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    jobs[jobId] = {
      id: jobId,
      channelId,
      movieName,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      progress: 0
    };
    
    fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
    
    setImmediate(() => {
      processAddMovieJob(jobId, {
        channelId,
        movieName,
        filePath,
        addedBy,
        fileSize,
        format
      });
    });
    
    res.json({ jobId, status: 'pending' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get job status
app.get('/api/job/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs[jobId];
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  res.json(job);
});

// Get all channels (public)
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

// Get schedule
app.get('/api/schedule/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  if (!channels[channelId]) {
    return res.status(400).json({ error: 'Invalid channel ID' });
  }
  res.json(channels[channelId].schedule || []);
});

// Get channel info
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

// Get status
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

// Get queue
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

// Web pages
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
        setInterval(loadChannels, 10000);
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
  
  let html = fs.readFileSync(filePath, 'utf8');
  
  const channelDataScript = `
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
    
    const originalInitPlayer = initPlayer;
    initPlayer = function() {
      originalInitPlayer();
      loadChannelInfo();
    };
  `;
  
  html = html.replace(
    'channelId = getChannelId();',
    `channelId = getChannelId();\n        ${channelDataScript}`
  );
  
  res.send(html);
});

// ==================== INITIALIZATION ====================

[publicDir, path.join(__dirname, 'ad'), path.join(__dirname, 'movies')].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

(async () => {
  for (const [id, config] of Object.entries(channels)) {
    await initializeChannel(id);
  }
})();

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📺 HLS streaming server ready`);
  console.log(`🎬 API endpoints available at /api/*`);
});
