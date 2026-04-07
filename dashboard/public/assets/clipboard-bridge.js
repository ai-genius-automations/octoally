/**
 * Clipboard Bridge for OctoAlly
 *
 * Fixes two problems:
 * 1. Ctrl+V doesn't paste text (OctoAlly uses Ctrl+Shift+V, but Windows users expect Ctrl+V)
 * 2. No way to paste images — uploads image, copies path to clipboard
 *
 * Also supports drag-and-drop for images.
 */
(function () {
  'use strict';

  // --- Config ---
  // Standalone image-drop server on port 7799 (same host, Tailscale-accessible)
  var IMAGE_DROP_PORT = 7799;
  var UPLOAD_URL = 'http://' + window.location.hostname + ':' + IMAGE_DROP_PORT + '/upload';
  var DEBUG_URL = '/api/debug/log'; // kept for optional OctoAlly debug logging
  var DEBOUNCE_MS = 500;
  var MAX_SIZE_BYTES = 10 * 1024 * 1024;
  var IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff'];

  var lastActionTime = 0;
  var _ctrlVPending = false;
  var _ctrlVFallbackTimer = null;

  // --- Remote debug logger ---
  var _logBuffer = [];
  var _logTimer = null;

  function rlog() {
    // Debug logging disabled — re-enable by uncommenting body:
    // var line = '[cb] ' + arguments[0];
    // console.log(line);
    // _logBuffer.push(line);
    // clearTimeout(_logTimer);
    // _logTimer = setTimeout(flushLogs, 300);
  }

  function flushLogs() {
    if (_logBuffer.length === 0) return;
    var msgs = _logBuffer.splice(0);
    try {
      fetch(DEBUG_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgs: msgs })
      }).catch(function () {});
    } catch (e) {}
  }

  rlog('script loading...');

  // --- WebSocket capture ---
  var _WS = window.WebSocket;
  var _termSockets = [];

  window.WebSocket = function (url, protocols) {
    var ws = protocols !== undefined ? new _WS(url, protocols) : new _WS(url);

    if (typeof url === 'string' && url.indexOf('/api/terminal/') !== -1 && url.indexOf('passive=1') === -1) {
      _termSockets.push(ws);
      // rlog('terminal WS captured: ' + url);
      ws.addEventListener('close', function () {
        var i = _termSockets.indexOf(ws);
        if (i !== -1) _termSockets.splice(i, 1);
        // rlog('terminal WS closed, remaining: ' + _termSockets.length);
      });
    }

    return ws;
  };

  window.WebSocket.prototype = _WS.prototype;
  window.WebSocket.CONNECTING = _WS.CONNECTING;
  window.WebSocket.OPEN = _WS.OPEN;
  window.WebSocket.CLOSING = _WS.CLOSING;
  window.WebSocket.CLOSED = _WS.CLOSED;

  function sendTextToTerminal(text) {
    for (var i = _termSockets.length - 1; i >= 0; i--) {
      var ws = _termSockets[i];
      if (ws.readyState === _WS.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: text, paste: true }));
        return true;
      }
    }
    return false;
  }

  // --- DOM helpers ---

  function isTerminalFocused() {
    var el = document.activeElement;
    if (!el) return false;
    // Check multiple ways — xterm versions differ
    if (el.classList && el.classList.contains('xterm-helper-textarea')) return true;
    // Check if inside an xterm container
    var parent = el.closest ? el.closest('.xterm') : null;
    if (parent) return true;
    // Check textarea inside xterm
    if (el.tagName === 'TEXTAREA' && el.parentElement && el.parentElement.classList &&
        el.parentElement.classList.contains('xterm-helper-textarea-container')) return true;
    return false;
  }

  function isNativeInputFocused() {
    var el = document.activeElement;
    if (!el) return false;
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !isTerminalFocused()) {
      return true;
    }
    return el.isContentEditable === true;
  }

  // --- Toast ---

  var toastEl = null;
  var toastTimer = null;

  function showToast(msg, isError) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText =
        'position:fixed;bottom:20px;right:20px;z-index:99999;padding:12px 18px;' +
        'border-radius:8px;font-family:monospace;font-size:13px;line-height:1.4;' +
        'max-width:440px;opacity:0;transform:translateY(8px);' +
        'transition:opacity .2s,transform .2s;pointer-events:none;color:#e0e0e0;' +
        'background:rgba(30,30,30,.95);border:1px solid #444;' +
        'box-shadow:0 4px 12px rgba(0,0,0,.4)';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.borderColor = isError ? '#c44' : '#4a4';
    toastEl.style.opacity = '1';
    toastEl.style.transform = 'translateY(0)';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (toastEl) {
        toastEl.style.opacity = '0';
        toastEl.style.transform = 'translateY(8px)';
      }
    }, isError ? 5000 : 3500);
  }

  // --- Clipboard write ---

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    ta.remove();
    return ok;
  }

  // --- Image upload ---

  function uploadImage(file) {
    if (file.size > MAX_SIZE_BYTES) {
      showToast('Image too large (max 10MB)', true);
      return Promise.resolve(null);
    }

    // rlog('uploading image: ' + file.name + ' size=' + file.size + ' type=' + file.type);

    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(file);
    }).then(function (base64) {
      // rlog('base64 ready, length=' + base64.length);
      var name = file.name || ('paste.' + (file.type.split('/')[1] || 'png'));
      return fetch(UPLOAD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, data: base64 })
      });
    }).then(function (resp) {
      // rlog('upload response: ' + resp.status);
      if (!resp.ok) {
        showToast('Upload failed (' + resp.status + ')', true);
        return null;
      }
      return resp.json().then(function (j) { return j.path; });
    });
  }

  function isImageType(type) {
    return IMAGE_TYPES.indexOf(type) !== -1;
  }

  function getImageFromDataTransfer(dt) {
    if (!dt) return null;
    if (dt.files) {
      for (var i = 0; i < dt.files.length; i++) {
        if (isImageType(dt.files[i].type)) return dt.files[i];
      }
    }
    if (dt.items) {
      for (var j = 0; j < dt.items.length; j++) {
        if (dt.items[j].kind === 'file' && isImageType(dt.items[j].type)) {
          return dt.items[j].getAsFile();
        }
      }
    }
    return null;
  }

  function handleImageUpload(file) {
    showToast('Uploading image...', false);
    uploadImage(file).then(function (path) {
      if (!path) return;
      // rlog('image saved: ' + path);
      copyToClipboard(path).then(function (copied) {
        if (copied) {
          showToast('Path copied! Ctrl+V to paste: ' + path, false);
        } else {
          showToast('Saved: ' + path + ' (copy manually)', true);
        }
      });
    }).catch(function (err) {
      // rlog('upload error: ' + (err.message || err));
      showToast('Upload failed: ' + (err.message || err), true);
    });
  }

  // --- Clipboard API fallback ---

  function clipboardApiFallback() {
    // rlog('using clipboard API fallback');
    if (navigator.clipboard && navigator.clipboard.read) {
      navigator.clipboard.read().then(function (items) {
        // rlog('clipboard.read() got ' + items.length + ' items');
        for (var i = 0; i < items.length; i++) {
          var types = items[i].types;
          // rlog('  item ' + i + ' types: ' + types.join(','));
          for (var t = 0; t < types.length; t++) {
            if (isImageType(types[t])) {
              items[i].getBlob(types[t]).then(function (blob) {
                var ext = blob.type.split('/')[1] || 'png';
                handleImageUpload(new File([blob], 'paste.' + ext, { type: blob.type }));
              });
              return;
            }
          }
          if (types.indexOf('text/plain') !== -1) {
            items[i].getBlob('text/plain').then(function (blob) {
              return blob.text();
            }).then(function (text) {
              if (text && !sendTextToTerminal(text)) {
                showToast('No active terminal for paste', true);
              }
            });
            return;
          }
        }
      }).catch(function (err) {
        // rlog('clipboard.read() denied: ' + (err.message || err));
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then(function (text) {
            if (text && !sendTextToTerminal(text)) {
              showToast('No active terminal for paste', true);
            }
          }).catch(function (err2) {
            // rlog('readText() also denied: ' + (err2.message || err2));
            showToast('Clipboard access denied — try Ctrl+Shift+V', true);
          });
        }
      });
    }
  }

  // --- Keydown: ALL key events logged for diagnosis ---

  document.addEventListener('keydown', function (e) {
    // Log every Ctrl+V attempt regardless of focus
    if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
      var el = document.activeElement;
      var elInfo = el ? (el.tagName + '.' + (el.className || '').substring(0, 60)) : 'null';
      // rlog('Ctrl+V detected | shift=' + e.shiftKey + ' | activeElement=' + elInfo +
      //   ' | isTerminal=' + isTerminalFocused() + ' | isNative=' + isNativeInputFocused() +
      //   ' | sockets=' + _termSockets.length);
    }

    // Only Ctrl+V without Shift
    if (!(e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === 'v' || e.key === 'V'))) return;
    if (isNativeInputFocused()) return;
    if (!isTerminalFocused()) return;

    var now = Date.now();
    if (now - lastActionTime < DEBOUNCE_MS) {
      e.preventDefault();
      return;
    }
    // Don't set lastActionTime here — let the paste handler set it.
    // Setting it here causes the paste handler's debounce to reject the event.

    e.stopPropagation();
    _ctrlVPending = true;
    // rlog('keydown intercepted, waiting for paste event...');

    clearTimeout(_ctrlVFallbackTimer);
    _ctrlVFallbackTimer = setTimeout(function () {
      if (_ctrlVPending) {
        _ctrlVPending = false;
        // rlog('paste event never fired (200ms timeout), using clipboard API fallback');
        clipboardApiFallback();
      }
    }, 200);
  }, true);

  // --- Paste event (primary handler) ---

  document.addEventListener('paste', function (e) {
    var isFromCtrlV = _ctrlVPending;
    if (isFromCtrlV) {
      _ctrlVPending = false;
      clearTimeout(_ctrlVFallbackTimer);
    }

    var types = e.clipboardData ? Array.from(e.clipboardData.types) : [];
    var fileCount = e.clipboardData ? e.clipboardData.files.length : 0;
    // rlog('paste event | fromCtrlV=' + isFromCtrlV + ' | types=' + types.join(',') + ' | files=' + fileCount);

    var file = getImageFromDataTransfer(e.clipboardData);
    if (file) {
      // rlog('image found in paste: ' + file.type + ' size=' + file.size);
      var now = Date.now();
      if (now - lastActionTime < DEBOUNCE_MS) return;
      lastActionTime = now;
      e.preventDefault();
      e.stopPropagation();
      handleImageUpload(file);
      return;
    }

    if (isFromCtrlV) {
      var text = '';
      try { text = (e.clipboardData || window.clipboardData).getData('text/plain'); } catch (ex) {}
      // rlog('text from paste event: ' + (text ? text.length + ' chars' : 'empty'));
      if (text) {
        e.preventDefault();
        e.stopPropagation();
        if (!sendTextToTerminal(text)) {
          showToast('No active terminal for paste', true);
        }
        return;
      }
    }
  }, true);

  // --- Drag and drop ---

  document.addEventListener('dragover', function (e) {
    if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') !== -1) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });

  document.addEventListener('drop', function (e) {
    var file = getImageFromDataTransfer(e.dataTransfer);
    if (!file) return;

    e.preventDefault();
    var now = Date.now();
    if (now - lastActionTime < DEBOUNCE_MS) return;
    lastActionTime = now;

    // rlog('image dropped: ' + file.type + ' size=' + file.size);
    handleImageUpload(file);
  });

  rlog('script loaded OK, WS patched');
})();
