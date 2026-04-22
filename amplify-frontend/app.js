// ═══════════════════════════════════════════════════════════════════
//  FILM-SECURE · app.js
//  Connects frontend to the ECS FastAPI backend.
//
//  API used:
//    POST /api/upload
//      body: FormData { file, interp_factor, quality }
//      response: { job_id: "xxx" }
//
//    GET /api/job/{job_id}
//      response: {
//        status:   "queued|preprocessing|processing|completed|failed"
//        progress: 0-100,
//        message:  "...",
//        result:   { download_url, original_fps, enhanced_fps, ... }
//      }
// ═══════════════════════════════════════════════════════════════════

// ── CONFIGURATION ────────────────────────────────────────────────────────────
const API_BASE_URL    = 'https://vf-22de0586fba54274b7d8b1daba37623d.ecs.us-east-1.on.aws';
const POLL_INTERVAL_MS = 3000;   // check status every 3 seconds

// ── DOM REFS ─────────────────────────────────────────────────────────────────
const dropZone      = document.getElementById('drop-zone');
const fileInput     = document.getElementById('file-input');
const filePreview   = document.getElementById('file-preview');
const fileNameEl    = document.getElementById('file-name-display');
const fileMetaEl    = document.getElementById('file-meta-display');
const fileRemoveBtn = document.getElementById('file-remove-btn');
const errorBanner   = document.getElementById('error-banner');
const errorTextEl   = document.getElementById('error-text');
const submitBtn     = document.getElementById('submit-btn');

const uploadPanel   = document.getElementById('upload-panel');
const progressPanel = document.getElementById('progress-panel');
const resultPanel   = document.getElementById('result-panel');

const jobIdEl       = document.getElementById('job-id-display');
const progressBar   = document.getElementById('progress-bar');
const progressMsg   = document.getElementById('progress-message');
const progressPct   = document.getElementById('progress-pct');
const logBox        = document.getElementById('log-box');
const cancelBtn     = document.getElementById('cancel-btn');

const downloadBtn   = document.getElementById('download-btn');
const resetBtn      = document.getElementById('reset-btn');

// ── STATE ────────────────────────────────────────────────────────────────────
let selectedFile = null;
let pollTimer    = null;
let currentJobId = null;

// ── STAGE ORDER (matches HTML ids) ───────────────────────────────────────────
const STAGE_ORDER = ['stage-upload','stage-queue','stage-preprocess','stage-inference','stage-export'];

// Maps API status values → which stage to mark active
const STATUS_TO_STAGE = {
  'queued':        'stage-queue',
  'starting':      'stage-queue',
  'preprocessing': 'stage-preprocess',
  'processing':    'stage-inference',
  'inference':     'stage-inference',
  'exporting':     'stage-export',
  'completed':     'stage-export',
  'done':          'stage-export',
};

// Maps API status → default progress % (used when API doesn't send progress)
const STATUS_TO_PCT = {
  'queued':        20,
  'starting':      25,
  'preprocessing': 40,
  'processing':    60,
  'inference':     70,
  'exporting':     88,
  'completed':     100,
  'done':          100,
};

// ════════════════════════════════════════════════════════════════════
//  FILE SELECTION
// ════════════════════════════════════════════════════════════════════

dropZone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) attachFile(fileInput.files[0]);
});

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) attachFile(e.dataTransfer.files[0]);
});

fileRemoveBtn.addEventListener('click', () => {
  selectedFile = null;
  fileInput.value = '';
  filePreview.style.display = 'none';
  submitBtn.disabled = true;
  hideError();
});

function attachFile(file) {
  // Validate size (2 GB max)
  if (file.size > 2 * 1024 * 1024 * 1024) {
    showError('File too large. Maximum size is 2 GB.');
    return;
  }
  hideError();
  selectedFile = file;
  fileNameEl.textContent = file.name;
  fileMetaEl.textContent = `${(file.size / 1048576).toFixed(1)} MB · ${file.type || 'video'}`;
  filePreview.style.display = 'flex';
  submitBtn.disabled = false;
}

// ════════════════════════════════════════════════════════════════════
//  SUBMIT — upload video & start polling
// ════════════════════════════════════════════════════════════════════

submitBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  hideError();
  submitBtn.disabled = true;

  // Switch to progress panel
  showPanel('progress');

  // Mark upload stage active
  setStage('stage-upload', 'active', 'UPLOADING');
  setProgress(10, 'Uploading video to S3...');
  addLog('Uploading video to S3 via API gateway...');

  try {
    // ── POST /api/upload ──────────────────────────────────────────
    const formData = new FormData();
    formData.append('file', selectedFile);
    formData.append('interp_factor', '2');
    formData.append('quality', 'high');

    const uploadRes = await fetch(`${API_BASE_URL}/api/upload`, {
      method: 'POST',
      body:   formData,
    });

    if (!uploadRes.ok) {
      const errBody = await uploadRes.json().catch(() => ({}));
      throw new Error(errBody.detail || `Upload failed (HTTP ${uploadRes.status})`);
    }

    const { job_id } = await uploadRes.json();
    currentJobId = job_id;

    // Show job ID
    jobIdEl.textContent = job_id;
    setStage('stage-upload', 'done', 'DONE');
    setProgress(20, 'Job registered. Waiting for worker...');
    addLog(`Job registered: ${job_id}`, 'accent');

    // Move to queue stage
    setStage('stage-queue', 'active', 'WAITING');
    addLog('Job placed in SageMaker processing queue...');

    // Start polling
    startPolling(job_id);

  } catch (err) {
    // Go back to upload panel and show error
    showPanel('upload');
    submitBtn.disabled = false;
    showError(`Upload failed: ${err.message}`);
    addLog(`ERROR: ${err.message}`, 'err');
    console.error(err);
  }
});

// ════════════════════════════════════════════════════════════════════
//  POLLING — GET /api/job/{job_id} every 3 seconds
// ════════════════════════════════════════════════════════════════════

function startPolling(jobId) {
  if (pollTimer) clearInterval(pollTimer);

  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/job/${jobId}`);
      if (!res.ok) {
        addLog(`Status check error: HTTP ${res.status}`, 'warn');
        return;
      }
      const data = await res.json();
      handleStatusUpdate(data, jobId);
    } catch (e) {
      addLog(`Network error: ${e.message}`, 'warn');
    }
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function handleStatusUpdate(data, jobId) {
  const status   = data.status   || '';
  const progress = data.progress ?? STATUS_TO_PCT[status] ?? 0;
  const message  = data.message  || '';
  // result can be at data.result{} or directly on data (different backends)
  const result   = data.result   || data;

  // Log any new message
  if (message) addLog(message);

  // Update progress bar
  setProgress(progress, message || status.toUpperCase());

  // Update stages
  const activeStage = STATUS_TO_STAGE[status];
  if (activeStage) {
    const activeIdx = STAGE_ORDER.indexOf(activeStage);
    STAGE_ORDER.forEach((s, i) => {
      if      (i < activeIdx)  setStage(s, 'done',   'DONE');
      else if (i === activeIdx) setStage(s, 'active', labelForStatus(status));
    });
  }

  // Terminal states
  if (status === 'completed' || status === 'done') {
    stopPolling();
    STAGE_ORDER.forEach(s => setStage(s, 'done', 'DONE'));
    setProgress(100, 'Enhancement complete!');
    addLog('Enhancement complete. Video ready for download.', 'accent');
    setTimeout(() => showResult(result, jobId), 700);
  }

  if (status === 'failed') {
    stopPolling();
    const reason = message || data.error || 'Unknown error';
    addLog(`Pipeline failed: ${reason}`, 'err');
    setTimeout(() => {
      showPanel('upload');
      submitBtn.disabled = false;
      showError(`Processing failed: ${reason}`);
    }, 1000);
  }
}

function labelForStatus(status) {
  const labels = {
    queued:        'QUEUED',
    starting:      'STARTING',
    preprocessing: 'RUNNING',
    processing:    'RUNNING',
    inference:     'RUNNING',
    exporting:     'EXPORTING',
    completed:     'COMPLETE',
    done:          'COMPLETE',
  };
  return labels[status] || status.toUpperCase();
}

// ════════════════════════════════════════════════════════════════════
//  RESULT PANEL
// ════════════════════════════════════════════════════════════════════

function showResult(result, jobId) {
  showPanel('result');

  // Populate stats — handle both direct fields and nested result{}
  document.getElementById('orig-fps').textContent      = result.original_fps            ?? '—';
  document.getElementById('enhanced-fps').textContent  = result.enhanced_fps            ?? '—';
  document.getElementById('frames-interp').textContent = result.interpolated_frames_added
                                                       ?? result.interpolated_frames
                                                       ?? result.frames_added           ?? '—';
  document.getElementById('resolution').textContent    = result.resolution              ?? '—';

  // Set download link
  const url = result.download_url ?? `${API_BASE_URL}/api/download/${jobId}`;
  downloadBtn.href = url;
}

// ════════════════════════════════════════════════════════════════════
//  CANCEL & RESET
// ════════════════════════════════════════════════════════════════════

cancelBtn.addEventListener('click', () => {
  stopPolling();
  currentJobId = null;
  resetProgressUI();
  showPanel('upload');
  submitBtn.disabled = (selectedFile === null);
});

resetBtn.addEventListener('click', () => {
  stopPolling();
  currentJobId = null;
  selectedFile = null;
  fileInput.value = '';
  filePreview.style.display = 'none';
  submitBtn.disabled = true;
  hideError();
  resetProgressUI();
  showPanel('upload');
});

function resetProgressUI() {
  progressBar.style.width = '0%';
  progressMsg.textContent = 'Initialising...';
  progressPct.textContent = '0%';
  logBox.innerHTML = '<span class="log-line accent">[FILM-SECURE] Pipeline initialised</span>';
  STAGE_ORDER.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'stage';
    el.querySelector('.stage-status').textContent = 'PENDING';
  });
  jobIdEl.textContent = '—';
}

// ════════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════════

function showPanel(name) {
  uploadPanel.style.display   = name === 'upload'   ? 'block' : 'none';
  progressPanel.style.display = name === 'progress' ? 'block' : 'none';
  resultPanel.style.display   = name === 'result'   ? 'block' : 'none';
}

function showError(msg) {
  errorTextEl.textContent = msg;
  errorBanner.style.display = 'flex';
}
function hideError() {
  errorBanner.style.display = 'none';
}

function setStage(id, state, label) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `stage ${state}`;
  el.querySelector('.stage-status').textContent = label;
}

function setProgress(pct, message) {
  const clamped = Math.min(100, Math.max(0, pct));
  progressBar.style.width = `${clamped}%`;
  progressPct.textContent = `${clamped}%`;
  if (message) progressMsg.textContent = message;
}

function addLog(msg, cls = '') {
  const ts   = new Date().toTimeString().slice(0, 8);
  const line = document.createElement('span');
  line.className   = `log-line${cls ? ' ' + cls : ''}`;
  line.textContent = `[${ts}] ${msg}`;
  logBox.appendChild(document.createElement('br'));
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}