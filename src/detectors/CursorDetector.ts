import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { IAIStateDetector } from './IAIStateDetector';
import { Logger } from '../utils/logger';

export class CursorDetector implements IAIStateDetector {
    private dbPath: string | null = null;
    private stateFilePath: string;
    private watcher: fs.FSWatcher | null = null;
    private onThinkingStartCallback: (() => void) | null = null;
    private onThinkingStopCallback: (() => void) | null = null;

    constructor(private context: vscode.ExtensionContext) {
        const cursorDir = path.join(os.homedir(), '.cursor');

        // Ensure .cursor directory exists (it likely does if they use Cursor, but good to be safe)
        if (!fs.existsSync(cursorDir)) {
            try {
                fs.mkdirSync(cursorDir, { recursive: true });
            } catch (e) {
                Logger.error('Failed to create .cursor directory', e, 'CursorDetector');
            }
        }

        this.stateFilePath = path.join(cursorDir, 'ai_thinking.txt');

        // Initialize state file if not exists
        if (!fs.existsSync(this.stateFilePath)) {
            try {
                fs.writeFileSync(this.stateFilePath, 'idle');
            } catch (e) {
                Logger.error('Failed to create state file', e, 'CursorDetector');
            }
        }
    }

    public onThinkingStart(callback: () => void) {
        this.onThinkingStartCallback = callback;
    }

    public onThinkingStop(callback: () => void) {
        this.onThinkingStopCallback = callback;
    }

    public async start() {
        Logger.log(`Monitoring state file: ${this.stateFilePath}`, 'CursorDetector');

        // 1. Show setup instructions to the user
        this.showSetupInstructions();

        // 2. Start watching the bridge file
        this.startWatching();
    }

    public stop() {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
    }

    public dispose() {
        this.stop();
    }

    private startWatching() {
        try {
            // Check initial state
            this.checkState();

            // Watch for changes
            // Using watchFile for cross-platform stability with small text files
            fs.watchFile(this.stateFilePath, { interval: 500 }, (curr, prev) => {
                if (curr.mtimeMs !== prev.mtimeMs) {
                    this.checkState();
                }
            });
        } catch (e) {
            Logger.error('Failed to start watcher', e, 'CursorDetector');
        }
    }

    private heartbeatInterval: NodeJS.Timeout | null = null;
    private stopDebounceTimer: NodeJS.Timeout | null = null;
    private readonly STOP_DEBOUNCE_MS = 5000;

    private checkState() {
        try {
            if (!fs.existsSync(this.stateFilePath)) {
                return;
            }

            const content = fs.readFileSync(this.stateFilePath, 'utf8').trim().toLowerCase();

            if (content === 'thinking') {
                // If we were pending stop, cancel it
                if (this.stopDebounceTimer) {
                    clearTimeout(this.stopDebounceTimer);
                    this.stopDebounceTimer = null;
                    Logger.log('Resumed thinking (debounce cancelled)', 'CursorDetector');
                }

                // Ensure heartbeat is running
                if (!this.heartbeatInterval) {
                    Logger.log('AI Thinking started (Heartbeat active)', 'CursorDetector');
                    this.startHeartbeat();
                }
            } else {
                // If currently "thinking" (heartbeat active) and not yet debouncing stop
                if (this.heartbeatInterval && !this.stopDebounceTimer) {
                    Logger.log(`AI Idle detected. Starting ${this.STOP_DEBOUNCE_MS}ms debounce timer...`, 'CursorDetector');

                    this.stopDebounceTimer = setTimeout(() => {
                        Logger.log('Debounce finished. Stopping AI state.', 'CursorDetector');
                        this.stopHeartbeat();
                        if (this.onThinkingStopCallback) {
                            this.onThinkingStopCallback();
                        }
                        this.stopDebounceTimer = null;
                    }, this.STOP_DEBOUNCE_MS);
                }
            }
        } catch (e) {
            Logger.error('Error reading state file', e, 'CursorDetector');
            this.stopHeartbeat();
        }
    }

    private startHeartbeat() {
        if (this.onThinkingStartCallback) {
            this.onThinkingStartCallback();
        }

        // Send a signal every 1 second to keep the extension alive
        this.heartbeatInterval = setInterval(() => {
            if (this.onThinkingStartCallback) {
                this.onThinkingStartCallback();
            }
        }, 1000);
    }

    private stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    private async showSetupInstructions() {
        const setupKey = 'cursorHooksSetupDone';
        const isSetupDone = this.context.globalState.get<boolean>(setupKey, false);

        if (!isSetupDone) {
            const msg = 'Doom While AI Works for Cursor: Setup Hooks for AI state detection.';
            const btnLabel = 'Show Instructions';
            const laterLabel = 'Later';

            const selection = await vscode.window.showInformationMessage(msg, btnLabel, laterLabel);

            if (selection === btnLabel) {
                this.openInstructions();
            }
        }
    }

    private openInstructions() {
        const setupKey = 'cursorHooksSetupDone';
        const panel = vscode.window.createWebviewPanel(
            'cursorHooksSetup',
            'Cursor Hooks Setup Guide',
            vscode.ViewColumn.Beside,
            { enableScripts: true }
        );

        // OS検出とコマンド生成
        const isWindows = process.platform === 'win32';
        const escapedPath = isWindows
            ? this.stateFilePath.replace(/\\/g, '\\\\')
            : this.stateFilePath;

        const thinkingCmd = isWindows
            ? `cmd /c echo thinking > "${escapedPath}"`
            : `echo thinking > "${escapedPath}"`;

        const idleCmd = isWindows
            ? `cmd /c echo idle > "${escapedPath}"`
            : `echo idle > "${escapedPath}"`;

        // Handle messages from the webview
        panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'copy':
                        vscode.env.clipboard.writeText(message.text);
                        return;
                    case 'done':
                        this.context.globalState.update(setupKey, true);
                        panel.dispose();
                        vscode.window.showInformationMessage(
                            'Setup marked as done. This guide will not be shown again.'
                        );
                        return;
                }
            },
            undefined,
            this.context.subscriptions
        );

        const content = {
            title: 'Configure Cursor Hooks',
            desc: 'To perfectly sync Cursor AI state with Doom, please follow these steps:',
            step1Label: 'Open (or create) the configuration file:',
            step2Label: 'Copy and paste the following JSON content into that file and save:',
            note: '<strong>Note:</strong> If you already have Hooks configured, add these to your existing configuration.',
            footer: 'Once set up, Doom will pause instantly when you send a chat and resume automatically when the response is finished!',
            doneBtn: 'I have finished setup (Don\'t show again)'
        };

        panel.webview.html = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: sans-serif; padding: 20px; line-height: 1.6; color: var(--vscode-foreground); }
                    pre { background: #333; color: #fff; padding: 15px; border-radius: 5px; overflow-x: auto; position: relative; }
                    .copy-btn { position: absolute; top: 10px; right: 10px; padding: 5px 10px; cursor: pointer; background: #007acc; border: none; color: white; border-radius: 3px; font-weight: bold; }
                    .copy-btn:hover { background: #0062a3; }
                    .done-btn { margin-top: 30px; padding: 10px 20px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; width: 100%; font-size: 1.1em; }
                    .done-btn:hover { background: var(--vscode-button-hoverBackground); }
                    code { font-family: monospace; }
                    h2 { color: var(--vscode-textLink-foreground); }
                    .path { color: #ce9178; font-weight: bold; }
                    ol li { margin-bottom: 10px; }
                    .footer-note { margin-top: 20px; border-top: 1px solid #555; padding-top: 20px; }
                </style>
            </head>
            <body>
                <h2>${content.title}</h2>
                <p>${content.desc}</p>
                
                <ol>
                    <li>${content.step1Label} <br><code>~/.cursor/hooks.json</code></li>
                    <li>${content.step2Label}</li>
                </ol>

                <pre id="jsonContent"><code>{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [
      {
        "command": "${thinkingCmd}"
      }
    ],
    "stop": [
      {
        "command": "${idleCmd}"
      }
    ]
  }
}</code><button class="copy-btn" id="copyBtn">Copy</button></pre>

                <p>${content.note}</p>
                <p class="footer-note">${content.footer}</p>

                <button class="done-btn" id="doneBtn">${content.doneBtn}</button>

                <script>
                    const vscode = acquireVsCodeApi();
                    document.getElementById('copyBtn').addEventListener('click', () => {
                        const content = document.querySelector('#jsonContent code').innerText;
                        vscode.postMessage({
                            command: 'copy',
                            text: content
                        });
                        const btn = document.getElementById('copyBtn');
                        btn.innerText = 'Copied!';
                        setTimeout(() => btn.innerText = 'Copy', 2000);
                    });

                    document.getElementById('doneBtn').addEventListener('click', () => {
                        vscode.postMessage({
                            command: 'done'
                        });
                    });
                </script>
            </body>
            </html>
        `;
    }
}
