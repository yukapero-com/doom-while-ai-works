import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class DoomController {
  private _panel: vscode.WebviewPanel | undefined;
  private readonly _context: vscode.ExtensionContext;
  private _disposables: vscode.Disposable[] = [];

  constructor(context: vscode.ExtensionContext) {
    this._context = context;

    // Listen for configuration changes
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('doom-while-ai-works.audio')) {
        this._updateAudioSettings();
      }
    }, null, this._disposables);
  }

  public start() {
    if (this._panel) {
      if (!this._panel.visible) {
        this._panel.reveal(vscode.ViewColumn.Active);
      }
      this._sendGameCommand('start');
      return;
    }

    const config = vscode.workspace.getConfiguration('doom-while-ai-works');
    const customWadPath = config.get<string>('game.wadPath', '');

    // Prepare resource roots
    const localResourceRoots = [vscode.Uri.file(path.join(this._context.extensionPath, 'media'))];

    // Check custom WAD
    let wadDirToAdd: string | undefined;
    if (customWadPath && customWadPath.trim().length > 0) {
      if (fs.existsSync(customWadPath)) {
        wadDirToAdd = path.dirname(customWadPath);
        localResourceRoots.push(vscode.Uri.file(wadDirToAdd));
      } else {
        // Error handling for missing WAD
        vscode.window.showErrorMessage(`Custom WAD not found: ${customWadPath}. Falling back to Freedoom.`);
      }
    }

    this._panel = vscode.window.createWebviewPanel(
      'doomWhileAIWorks',
      'Doom While AI Works',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: localResourceRoots,
        retainContextWhenHidden: true
      }
    );

    this._panel.webview.html = this._getWebviewContent(this._panel.webview);

    this._panel.webview.onDidReceiveMessage(
      async message => {
        switch (message.command) {
          case 'log':
            console.log('[WebView]', message.text);
            break;
          case 'error':
            console.error('[WebView Error]', message.text);
            vscode.window.showErrorMessage('Doom WebView Error: ' + message.text);
            break;
          case 'restoreAndFocusChat':
            // 1. Restore the previous editor tab
            vscode.commands.executeCommand('workbench.action.openPreviousRecentlyUsedEditorInGroup');

            // 2. Delay focusing the chat until the editor tab restoration has processed.
            // executeCommand for UI actions often resolves before the DOM/focus has fully settled.
            setTimeout(() => {
              if (vscode.env.appName.includes('Cursor')) {
                // Focus existing Chat in Cursor
                vscode.commands.executeCommand('aichat.action.focus');
              } else {
                // Default VS Code behavior
                vscode.commands.executeCommand('workbench.action.chat.open');
              }
            }, 150);
            break;
        }
      },
      null,
      this._disposables
    );

    this._panel.onDidDispose(() => {
      this._panel = undefined;
    }, null, this._disposables);
  }

  public stop() {
    if (this._panel) {
      this._sendGameCommand('pause');
      // 思考中はフォーカスをエディタに戻すことで「裏でプレイさせない」感を出す
    }
  }

  public dispose() {
    if (this._panel) {
      this._panel.dispose();
    }
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _sendGameCommand(command: 'start' | 'pause') {
    if (this._panel) {
      this._panel.webview.postMessage({ command: command });
    }
  }

  private _updateAudioSettings() {
    if (this._panel) {
      const config = vscode.workspace.getConfiguration('doom-while-ai-works');
      const volume = config.get<number>('audio.volume', 100) / 100;
      const muted = config.get<boolean>('audio.muted', false);

      this._panel.webview.postMessage({
        command: 'setAudioConfig',
        volume: volume,
        muted: muted
      });
    }
  }

  private _getWebviewContent(webview: vscode.Webview): string {
    // Assets URIs
    const mediaPath = vscode.Uri.file(path.join(this._context.extensionPath, 'media'));
    const wasmPath = vscode.Uri.file(path.join(this._context.extensionPath, 'media', 'wasm'));

    const engineJsUri = webview.asWebviewUri(vscode.Uri.joinPath(wasmPath, 'engine.js'));
    const engineWasmUri = webview.asWebviewUri(vscode.Uri.joinPath(wasmPath, 'engine.wasm'));
    const prboomWadUri = webview.asWebviewUri(vscode.Uri.joinPath(wasmPath, 'prboom.wad'));

    // Scan for SFX files
    const sfxPathDisk = path.join(wasmPath.fsPath, 'sfx');
    let sfxFiles: string[] = [];
    try {
      if (fs.existsSync(sfxPathDisk)) {
        sfxFiles = fs.readdirSync(sfxPathDisk).filter(f => f.endsWith('.wav'));
      }
    } catch (e) { console.error("Error scanning sfx:", e); }
    const sfxListJson = JSON.stringify(sfxFiles);
    const sfxBaseUri = webview.asWebviewUri(vscode.Uri.joinPath(wasmPath, 'sfx'));

    // Scan for Music files
    const musicPathDisk = path.join(wasmPath.fsPath, 'music');
    let musicFiles: string[] = [];
    try {
      if (fs.existsSync(musicPathDisk)) {
        musicFiles = fs.readdirSync(musicPathDisk).filter(f => /\.(mp3|ogg|wav|opus|m4a|aac|flac)$/i.test(f));
      }
    } catch (e) { console.error("Error scanning music:", e); }
    const musicListJson = JSON.stringify(musicFiles);
    const musicBaseUri = webview.asWebviewUri(vscode.Uri.joinPath(wasmPath, 'music'));

    // Configuration
    const config = vscode.workspace.getConfiguration('doom-while-ai-works');
    const skipTitle = config.get<boolean>('game.skipTitle', true);
    const difficulty = config.get<number>('game.difficulty', 3);
    const volume = config.get<number>('audio.volume', 100) / 100; // 0.0 - 1.0
    const muted = config.get<boolean>('audio.muted', false);
    const customWadPath = config.get<string>('game.wadPath', '');

    // Determine WAD to use
    let wadUri = webview.asWebviewUri(vscode.Uri.joinPath(wasmPath, 'freedoom.wad'));
    let wadName = 'freedoom.wad';

    if (customWadPath && customWadPath.trim().length > 0) {
      if (fs.existsSync(customWadPath)) {
        wadUri = webview.asWebviewUri(vscode.Uri.file(customWadPath));
        wadName = path.basename(customWadPath);
      }
    }

    // Args Logic
    // Run in root. WAD is at /<wadName>, config at /antigravity.cfg
    // Save directory is explicitly set to /save (IDBFS mount)
    const doomArgs = skipTitle
      ? `["-iwad", "/${wadName}", "-config", "/antigravity.cfg", "-save", "/save", "-skill", "${difficulty}", "-warp", "1"]`
      : `["-iwad", "/${wadName}", "-config", "/antigravity.cfg", "-save", "/save"]`;

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'unsafe-eval' ${webview.cspSource}; connect-src ${webview.cspSource} data:;">
    <title>WASM Doom</title>
    <style>
      body { margin: 0; background-color: #000; color: #fff; overflow: hidden; }
      #canvas {
        position: absolute;
        top: 0; left: 0; width: 100%; height: 100%;
        image-rendering: pixelated;
        outline: none;
      }
      #status {
        position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
        font-family: 'Impact', 'Arial Black', sans-serif;
        font-size: 48px;
        text-align: center;
        z-index: 200;
        pointer-events: none;
        color: #ff3300;
        text-shadow: 
          3px 3px 0 #000,
          -3px -3px 0 #000,  
          3px -3px 0 #000,
          -3px 3px 0 #000,
          5px 5px 15px rgba(0,0,0,0.8);
        line-height: 1.2;
        text-transform: uppercase;
        animation: blink 0.8s infinite;
      }
      @keyframes blink {
        0% { opacity: 1; }
        50% { opacity: 0.7; }
        100% { opacity: 1; }
      }
      #controls {
        position: absolute; top: 10px; right: 10px; z-index: 100;
        display: flex; align-items: center; gap: 10px;
        background: rgba(0, 0, 0, 0.5); padding: 5px 10px; border-radius: 4px;
        transition: opacity 0.3s;
        opacity: 0; /* Default hidden, shown on mouse move */
        pointer-events: auto;
      }
      #controls.visible {
        opacity: 1;
      }
      #controls.hidden {
        opacity: 0 !important;
        pointer-events: none;
      }
      label { font-family: sans-serif; font-size: 14px; font-weight: bold; }
      input[type=range] { vertical-align: middle; }
      
      #instructions {
        position: absolute; bottom: 0; left: 0; width: 100%;
        font-family: sans-serif; color: rgba(255, 255, 255, 0.9);
        display: flex; flex-direction: row; flex-wrap: wrap; justify-content: center; align-items: center; gap: 4px 20px;
        background: rgba(0, 0, 0, 0.85); padding: 3px 10px;
        transition: opacity 0.3s;
        z-index: 101; pointer-events: none;
        box-sizing: border-box;
      }
      #instructions h2 { display: none; }
      #instructions p { margin: 0; font-size: 12px; white-space: nowrap; }
      #instructions.hidden {
        opacity: 0;
        pointer-events: none !important;
      }
      .key {
        display: inline-block; border: 1px solid #aaa; border-radius: 3px;
        padding: 1px 4px; margin: 0 2px; background: rgba(255,255,255,0.1); font-weight: bold;
      }
      .click-to-play {
        font-size: 1.0em;
        font-weight: 900;
        color: #fff;
        text-transform: uppercase;
        letter-spacing: 2px;
        animation: pulse 1.5s infinite;
        white-space: nowrap;
        margin: 2px 10px;
        flex: 1 1 100%; /* Take full width to center effectively when wrapped */
        text-align: center;
      }
      @keyframes pulse {
        0% { opacity: 0.4; }
        50% { opacity: 1; }
        100% { opacity: 0.4; }
      }
    </style>
  </head>
  <body>
    <!-- Instructions Overlay -->
    <div id="instructions">
      <h2>Controls</h2>
      <p><span class="key">W</span><span class="key">A</span><span class="key">S</span><span class="key">D</span> to Move</p>
      <p><span class="key">Mouse</span> to Look & Shoot</p>
      <p><span class="key">Space</span> to Open / Interact</p>
      <p><span class="key">ESC</span> to Unlock Mouse</p>
      <div class="click-to-play">CLICK SCREEN TO PLAY</div>
    </div>

    <div id="status">Loading WASM Doom...</div>
    <canvas id="canvas" oncontextmenu="event.preventDefault()" tabindex="-1"></canvas>

    <!-- Volume Controls -->
    <div id="controls">
      <label for="volumeSlider">Volume</label>
      <input type="range" id="volumeSlider" min="0" max="100" value="${Math.round(volume * 100)}">
    </div>

    <!-- Audio Shim & Logic -->
    <script>
      (function() {
        // Initialize Global Settings
        // Load volume from storage if available
        var storedVolume = localStorage.getItem('doom-while-ai-works.volume');
        var initialVolume = storedVolume ? parseFloat(storedVolume) : ${volume};
        
        window.userVolume = initialVolume;
        window.userMuted = ${muted};
        window.doomMasterGain = null;

        // Update UI to match stored volume
        document.getElementById('volumeSlider').value = Math.round(initialVolume * 100);

        // --- AudioContext Shim ---
        const OriginalAudioContext = window.AudioContext || window.webkitAudioContext;
        if (!OriginalAudioContext) return;

        window.AudioContext = class extends OriginalAudioContext {
          constructor(options) {
            super(options);
            this._masterGain = this.createGain();
            this._masterGain.connect(super.destination);
            
            window.doomMasterGain = this._masterGain;
            window.updateEffectiveVolume(); // Apply initial volume
          }

          get destination() {
            return this._masterGain;
          }
        };
      })();

      // Called when settings change
      window.updateEffectiveVolume = function() {
        if (!window.doomMasterGain) return;
        
        // If user muted, gain = 0. Else gain = userVolume.
        const targetGain = window.userMuted ? 0 : window.userVolume;
        
        // Smooth transition to avoid clicks
        const now = window.doomMasterGain.context.currentTime;
        window.doomMasterGain.gain.setValueAtTime(targetGain, now);
      };

      // UI Event Listener
      const controls = document.getElementById('controls');
      const instructions = document.getElementById('instructions');
      
      document.getElementById('volumeSlider').addEventListener('input', function(e) {
        window.userVolume = parseInt(e.target.value, 10) / 100;
        window.updateEffectiveVolume();
        // Persist volume
        localStorage.setItem('doom-while-ai-works.volume', window.userVolume);
      });

      // --- Instructions Logic ---
      function checkInstructions() {
        // Shown initially if not pointer locked
        if (!document.pointerLockElement) {
          instructions.classList.remove('hidden');
        }
      }

      // Initialize Instructions
      checkInstructions();


      // --- Visibility Logic ---
      let hideTimeout = null;
      let isHoveringControls = false;
      let isPointerLocked = false;

      function showControls() {
        if (isPointerLocked) return; // Never show when locked
        controls.classList.add('visible');
        resetHideTimer();
      }

      function hideControls() {
        // Don't hide if hovering controls (unless locked, which is handled elsewhere)
        if (isHoveringControls && !isPointerLocked) return;
        controls.classList.remove('visible');
      }

      function resetHideTimer() {
        if (hideTimeout) clearTimeout(hideTimeout);
        if (!isHoveringControls) {
            hideTimeout = setTimeout(hideControls, 3000);
        }
      }

      // Mouse Move (Body) - Show controls briefly
      document.body.addEventListener('mousemove', function() {
        showControls();
      });

      // Hover checks
      controls.addEventListener('mouseenter', () => { isHoveringControls = true; showControls(); });
      controls.addEventListener('mouseleave', () => { isHoveringControls = false; resetHideTimer(); });

      // Auto-hide UI on pointer lock
      document.addEventListener('pointerlockchange', function() {
        const canvas = document.getElementById('canvas');
        isPointerLocked = (document.pointerLockElement === canvas);

        if (isPointerLocked) {
          // Game Active
          controls.classList.remove('visible');
          controls.classList.add('hidden'); // Force hide
          instructions.classList.add('hidden'); // Hide instructions
        } else {
          // Game Paused / Menu
          controls.classList.remove('hidden'); // Allow showing
          // Only show instructions if NOT in AI pause mode
          if (!isGamePaused) {
              instructions.classList.remove('hidden');
          }
          
          showControls(); // Show controls immediately on unlock
        }
      });

    </script>

    <script>
      const vscode = acquireVsCodeApi();
      const statusElement = document.getElementById('status');

      // --- Game Loop Control (Pause/Resume) ---
      var isGamePaused = false;
      var pendingAnimationFrame = null;
      var originalRequestAnimationFrame = window.requestAnimationFrame;

      // --- Key & Focus Tracking ---
      // Simplified: No longer waiting for keys. Immediate switch to Chat.
      
      window.requestAnimationFrame = function(callback) {
        if (isGamePaused) {
          pendingAnimationFrame = callback;
          return; 
        }
        return originalRequestAnimationFrame(callback);
      };

      function getAudioContext() {
          if (Module.SDL2 && Module.SDL2.audioContext) return Module.SDL2.audioContext;
          if (typeof SDL2 !== 'undefined' && SDL2.audioContext) return SDL2.audioContext;
          if (typeof SDL !== 'undefined' && SDL.audioContext) return SDL.audioContext;
          // Fallback to our shimmed one if stored
          if (window.doomMasterGain && window.doomMasterGain.context) return window.doomMasterGain.context;
          return null;
      }

      window.pauseGame = function() {
        if (isGamePaused) return;
        isGamePaused = true;
        
        // Force unlock mouse
        if (document.exitPointerLock) { document.exitPointerLock(); }

        console.log("[System] Game Paused (AI Mode)");
        statusElement.innerHTML = "GET BACK TO WORK!";
        statusElement.style.display = 'block';

        // Hide instructions during pause
        instructions.classList.add('hidden');

        // Restore editor tab but focus chat for safety
        vscode.postMessage({ command: 'restoreAndFocusChat' });

        // Mute Audio (Suspend)
        try {
            var actx = getAudioContext();
            if (actx && actx.state === 'running') {
                actx.suspend();
                console.log("[Audio] Suspended");
            }
        } catch(e) { console.error("Audio suspend failed", e); }
      };

      window.resumeGame = function() {
        if (!isGamePaused) return;
        isGamePaused = false;
        console.log("[System] Game Resumed");
        statusElement.innerText = "";
        statusElement.style.display = 'none';
        
        // Resume Audio
        try {
            var actx = getAudioContext();
            if (actx && actx.state === 'suspended') {
                actx.resume();
                console.log("[Audio] Resumed");
            }
        } catch(e) { console.error("Audio resume failed", e); }

        if (pendingAnimationFrame) {
          originalRequestAnimationFrame(pendingAnimationFrame);
          pendingAnimationFrame = null;
        }

        var canvas = document.getElementById('canvas');
        if (canvas) {
            canvas.focus();
            try {
                canvas.requestPointerLock = canvas.requestPointerLock || canvas.mozRequestPointerLock || canvas.webkitRequestPointerLock;
                canvas.requestPointerLock();
            } catch(e) { console.log("Auto pointer lock failed (expected):", e); }
        }
      };

      // Message Handler from Extension
      window.addEventListener('message', event => {
        const message = event.data;
        if (message.command === 'start') {
            window.resumeGame();
        } else if (message.command === 'pause') {
            window.pauseGame();
        } else if (message.command === 'setAudioConfig') {
            window.userVolume = message.volume;
            window.userMuted = message.muted;
            window.updateEffectiveVolume();
        }
      });
      // ----------------------------------------

      var isRuntimeInitialized = false;
      var isWadLoaded = false;

      function tryStartGame() {
        if (!isRuntimeInitialized || !isWadLoaded) {
          console.log('Doom: Waiting for dependencies... (Runtime: ' + isRuntimeInitialized + ', WAD: ' + isWadLoaded + ')');
          return;
        }

        console.log('Doom: All dependencies met. Starting game...');
        var Module = window.Module;
        var FS = Module.FS;
        var wadName = "${wadName}";

        // Robust FS check
        if (!FS && window.doomFS) FS = window.doomFS;
        if (!FS) {
          console.error('Doom Critical Error: FS not found even when Ready.');
          vscode.postMessage({ command: 'error', text: "Critical: Filesystem not available." });
          return;
        }

        console.log("Doom Debug: FS Root contents:", JSON.stringify(FS.readdir('/')));
        
        try {
          // 1. Setup Persistence
          try { FS.mkdir('/save'); } catch(e) {}
          FS.mount(FS.filesystems.IDBFS, {}, '/save');

          // 2. Sync and Start
          FS.syncfs(true, function(err) {
            if (err) console.error('Error loading saves from IDBFS:', err);
            else {
                console.log('Saves loaded from IndexedDB to /save mount.');
            }
            
            // 3. Hook FS.close for Persistence
            // We use -save /save, so engine writes directly to /save/doomsav*.dsg
            var originalClose = FS.close;
            FS.close = function(stream) {
              var res = originalClose(stream);
              try {
                  // Check if the file closed is within the /save mount
                  if (stream.node && stream.node.mount && stream.node.mount.mountpoint === '/save') {
                     console.log('Detected save file update (in /save): ' + stream.node.name);
                     FS.syncfs(false, function(err) {
                        if (err) console.error('Error syncing to DB:', err);
                        else console.log('Persisted changes to IndexedDB');
                     });
                  }
              } catch(e) { /* ignore extra errors in hook */ }
              return res;
            };

            console.log('Calling main...');
            Module.callMain(Module.arguments);
          });

        } catch (e) {
          console.error('Doom Setup Error:', e);
          vscode.postMessage({ command: 'error', text: "Setup Error: " + e.message });
        }
      }

      var Module = {
        noInitialRun: true,
        preRun: [function() {
          console.log('Doom preRun: Starting WAD download...');
          var wadUrl = "${wadUri}";
          var prboomUrl = "${prboomWadUri}";
          
          Module.addRunDependency("load_assets");
          
          Promise.all([
            fetch(wadUrl).then(r => { if(!r.ok) throw new Error("Failed to load wad"); return r.arrayBuffer(); }),
            fetch(prboomUrl).then(r => { if(!r.ok) throw new Error("Failed to load prboom.wad"); return r.arrayBuffer(); })
          ]).then(async ([wadData, prboomData]) => {
              console.log('Doom preRun: Assets downloaded.');
              var fs = Module.FS || window.FS;
              
              try {
                  fs.createDataFile('/', '${wadName}', new Uint8Array(wadData), true, true, true);
                  fs.createDataFile('/', 'prboom.wad', new Uint8Array(prboomData), true, true, true);
                  
                  // Create necessary directories
                  try { fs.mkdir('/music'); } catch(e) {}
                  try { fs.mkdir('/sfx'); } catch(e) {}

                  // Load SFX files
                  var sfxFiles = ${sfxListJson};
                  var sfxBase = "${sfxBaseUri}/";
                  
                  if (sfxFiles.length > 0) {
                      console.log("Loading " + sfxFiles.length + " SFX files...");
                      var sfxPromises = sfxFiles.map(function(f) {
                          return fetch(sfxBase + f).then(function(r) { return r.arrayBuffer(); }).then(function(buf) {
                              try { fs.createDataFile('/sfx', f, new Uint8Array(buf), true, true, true); } catch(e) { console.warn("Failed to write sfx: " + f); }
                          });
                      });
                      await Promise.all(sfxPromises);
                      console.log("SFX loaded.");
                  }

                  // Load Music files
                  var musicFiles = ${musicListJson};
                  var musicBase = "${musicBaseUri}/";
                  
                  if (musicFiles.length > 0) {
                      console.log("Loading " + musicFiles.length + " music files...");
                      var musicPromises = musicFiles.map(function(f) {
                          return fetch(musicBase + f).then(function(r) { return r.arrayBuffer(); }).then(function(buf) {
                              try { fs.createDataFile('/music', f, new Uint8Array(buf), true, true, true); } catch(e) { console.warn("Failed to write music: " + f); }
                          });
                      });
                      await Promise.all(musicPromises);
                      console.log("Music loaded.");
                  }

                  console.log('Assets written to FS');
                  isWadLoaded = true;
                  Module.removeRunDependency("load_assets");
                  tryStartGame();
              } catch(e) {
                  console.error('FS Write Error:', e);
                  throw e;
              }
          }).catch(err => {
              console.error(err);
              statusElement.innerText = "Error loading Assets: " + err.message;
              vscode.postMessage({ command: 'error', text: err.message });
          });
        }],
        onRuntimeInitialized: function() {
          console.log('Doom onRuntimeInitialized: Runtime ready.');
          isRuntimeInitialized = true;
          tryStartGame();
        },
        postRun: [],
        print: function(text) {
          if (arguments.length > 1) text = Array.prototype.slice.call(arguments).join(' ');
          if (text.includes('WARNING: using emscripten GL')) return;
          if (text.includes('Cannot find preloaded audio')) return;
          
          console.log(text);
          if (text.includes('Error')) {
             vscode.postMessage({ command: 'log', text: text });
          }
        },
        printErr: function(text) {
          if (arguments.length > 1) text = Array.prototype.slice.call(arguments).join(' ');
          if (text.includes('WARNING: using emscripten GL')) return;
          if (text.includes('Cannot find preloaded audio')) return;
          console.error(text);
          vscode.postMessage({ command: 'error', text: text });
        },
        canvas: (function() {
          var canvas = document.getElementById('canvas');
          canvas.addEventListener("webglcontextlost", function(e) { alert('WebGL context lost. You will need to reload the page.'); e.preventDefault(); }, false);
          canvas.addEventListener("mousedown", function() {
            if (isGamePaused) return;
            window.focus();
            canvas.focus();
            canvas.requestPointerLock = canvas.requestPointerLock || canvas.mozRequestPointerLock || canvas.webkitRequestPointerLock;
            canvas.requestPointerLock();
          });
          return canvas;
        })(),
        setStatus: function(text) {
          if (!Module.setStatus.last) Module.setStatus.last = { time: Date.now(), text: '' };
          if (text === Module.setStatus.last.text) return;
          var m = text.match(/([^(]+)\\((\\d+(\\.\\d+)?)\\/(\\d+)\\)/);
          var now = Date.now();
          if (m && now - Module.setStatus.last.time < 30) return;
          Module.setStatus.last.time = now;
          Module.setStatus.last.text = text;
          if (m) text = m[1];
          // Don't overwrite our joke message during pause!
          if (isGamePaused) return;
          statusElement.innerText = text;
          if (!text) statusElement.style.display = 'none';
        },
        totalDependencies: 0,
        monitorRunDependencies: function(left) {
          this.totalDependencies = Math.max(this.totalDependencies, left);
          console.log('Dependencies left:', left);
          vscode.postMessage({ command: 'log', text: 'Dependencies left: ' + left });
          Module.setStatus(left ? 'Preparing... (' + (this.totalDependencies-left) + '/' + this.totalDependencies + ')' : 'All downloads complete.');
        },
        locateFile: function(path, prefix) {
          if (path.endsWith(".wasm")) return "${engineWasmUri}";
          return prefix + path;
        },
        arguments: ${doomArgs}
      };

      Module.setStatus('Downloading...');
      
      window.onerror = function(event) {
        Module.setStatus('Exception thrown, see JavaScript console');
        statusElement.style.display = 'block';
        Module.setStatus = function(text) {
          if (text) Module.printErr('[post-exception status] ' + text);
        };
      };
    </script>
    <script async src="${engineJsUri}"></script>
  </body>
</html>`;
  }
}
