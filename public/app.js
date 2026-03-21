/* ═══════════════════════════════════════════════════════════
   KOBO SEND — Frontend Logic
   ═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── Elements ────────────────────────────────────────
  const viewUpload = document.getElementById('view-upload');
  const viewCode = document.getElementById('view-code');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const fileInfo = document.getElementById('file-info');
  const fileName = document.getElementById('file-name');
  const fileSize = document.getElementById('file-size');
  const fileRemove = document.getElementById('file-remove');
  const progressBar = document.getElementById('progress-bar');
  const progressFill = document.getElementById('progress-fill');
  const btnSend = document.getElementById('btn-send');
  const codeDisplay = document.getElementById('code-display');
  const btnCopy = document.getElementById('btn-copy');
  const qrCanvas = document.getElementById('qr-canvas');
  const statusBadge = document.getElementById('status-badge');
  const statusText = document.getElementById('status-text');
  const expiryTimer = document.getElementById('expiry-timer');
  const btnAnother = document.getElementById('btn-another');

  // ─── State ───────────────────────────────────────────
  let selectedFile = null;
  let currentCode = null;
  let expiresAt = null;
  let pollingInterval = null;
  let timerInterval = null;

  // ─── Drag & Drop ────────────────────────────────────
  dropzone.addEventListener('click', () => fileInput.click());

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });

  dropzone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      selectFile(files[0]);
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      selectFile(fileInput.files[0]);
    }
  });

  // ─── File Selection ─────────────────────────────────
  function selectFile(file) {
    // Check size
    if (file.size > 100 * 1024 * 1024) {
      alert('File too large. Maximum size is 100 MB.');
      return;
    }

    selectedFile = file;
    fileName.textContent = file.name;
    fileSize.textContent = formatSize(file.size);
    fileInfo.classList.add('visible');
    btnSend.disabled = false;
  }

  fileRemove.addEventListener('click', () => {
    selectedFile = null;
    fileInput.value = '';
    fileInfo.classList.remove('visible');
    btnSend.disabled = true;
  });

  // ─── Upload ─────────────────────────────────────────
  btnSend.addEventListener('click', () => {
    if (!selectedFile) return;
    uploadFile(selectedFile);
  });

  function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);

    const xhr = new XMLHttpRequest();

    // Show progress
    progressBar.classList.add('visible');
    progressFill.style.width = '0%';
    btnSend.disabled = true;
    btnSend.innerHTML = '<span class="spinner"></span> Uploading…';

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        progressFill.style.width = pct + '%';
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status === 200) {
        const data = JSON.parse(xhr.responseText);
        currentCode = data.code;
        expiresAt = data.expiresAt;
        showCodeView(data);
      } else {
        alert('Upload failed. Please try again.');
        resetUploadUI();
      }
    });

    xhr.addEventListener('error', () => {
      alert('Connection error. Please try again.');
      resetUploadUI();
    });

    xhr.open('POST', '/upload');
    xhr.send(formData);
  }

  function resetUploadUI() {
    progressBar.classList.remove('visible');
    btnSend.disabled = false;
    btnSend.innerHTML = 'Send to Kobo';
  }

  // ─── Code View ──────────────────────────────────────
  function showCodeView(data) {
    // Switch views
    viewUpload.classList.remove('active');
    viewCode.classList.add('active');

    // Show code
    codeDisplay.textContent = data.code;

    // Generate QR
    const koboUrl = window.location.origin + '/kobo?code=' + data.code;
    new QRious({
      element: qrCanvas,
      value: koboUrl,
      size: 180,
      backgroundAlpha: 0,
      foreground: '#111',
      level: 'M'
    });

    // Set status
    setStatus('waiting', 'Waiting for device…');

    // Start polling
    startPolling(data.code);

    // Start countdown timer
    startTimer();
  }

  // ─── Copy Code ──────────────────────────────────────
  btnCopy.addEventListener('click', () => {
    if (!currentCode) return;

    navigator.clipboard.writeText(currentCode).then(() => {
      btnCopy.textContent = '✓ Copied!';
      btnCopy.classList.add('copied');
      setTimeout(() => {
        btnCopy.textContent = 'Copy code';
        btnCopy.classList.remove('copied');
      }, 2000);
    }).catch(() => {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = currentCode;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      btnCopy.textContent = '✓ Copied!';
      btnCopy.classList.add('copied');
      setTimeout(() => {
        btnCopy.textContent = 'Copy code';
        btnCopy.classList.remove('copied');
      }, 2000);
    });
  });

  // ─── Polling ────────────────────────────────────────
  function startPolling(code) {
    stopPolling();

    pollingInterval = setInterval(() => {
      fetch('/status/' + code)
        .then(r => r.json())
        .then(data => {
          if (data.status === 'connected') {
            setStatus('connected', 'Connected — downloading!');
            stopPolling();
          } else if (data.status === 'expired') {
            setStatus('expired', 'Code expired');
            stopPolling();
            stopTimer();
          }
        })
        .catch(() => {
          // Silently retry on network failure
        });
    }, 2000);
  }

  function stopPolling() {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  }

  // ─── Status ─────────────────────────────────────────
  function setStatus(status, text) {
    statusBadge.setAttribute('data-status', status);
    statusText.textContent = text;
  }

  // ─── Expiry Timer ───────────────────────────────────
  function startTimer() {
    stopTimer();
    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function updateTimer() {
    if (!expiresAt) return;
    const remaining = expiresAt - Date.now();

    if (remaining <= 0) {
      expiryTimer.textContent = 'Code has expired';
      setStatus('expired', 'Code expired');
      stopTimer();
      stopPolling();
      return;
    }

    const min = Math.floor(remaining / 60000);
    const sec = Math.floor((remaining % 60000) / 1000);
    expiryTimer.textContent = `Expires in ${min}:${String(sec).padStart(2, '0')}`;
  }

  // ─── Upload Another ────────────────────────────────
  btnAnother.addEventListener('click', () => {
    stopPolling();
    stopTimer();

    // Reset
    selectedFile = null;
    currentCode = null;
    expiresAt = null;
    fileInput.value = '';
    fileInfo.classList.remove('visible');
    progressBar.classList.remove('visible');
    progressFill.style.width = '0%';
    btnSend.disabled = true;
    btnSend.innerHTML = 'Send to Kobo';

    // Switch views
    viewCode.classList.remove('active');
    viewUpload.classList.add('active');
  });

  // ─── Helpers ────────────────────────────────────────
  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

})();
