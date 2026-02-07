import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { IAIStateDetector } from './IAIStateDetector';
import { Logger } from '../utils/logger';

export class CursorDetector implements IAIStateDetector {
    private dbPath: string | null = null;
    private stateFilePath: string;
    private watcher: fs.FSWatcher | null = null;
    private onThinkingStartCallback: (() => void) | null = null;
    private onThinkingStopCallback: (() => void) | null = null;

    constructor(private context: vscode.ExtensionContext) {
        // Ensure global storage exists
        if (!fs.existsSync(this.context.globalStorageUri.fsPath)) {
            fs.mkdirSync(this.context.globalStorageUri.fsPath, { recursive: true });
        }
        this.stateFilePath = path.join(this.context.globalStorageUri.fsPath, 'cursor_ai_state.txt');

        // Initialize state file if not exists
        if (!fs.existsSync(this.stateFilePath)) {
            fs.writeFileSync(this.stateFilePath, 'idle');
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

    private checkState() {
        try {
            if (!fs.existsSync(this.stateFilePath)) {
                return;
            }

            const content = fs.readFileSync(this.stateFilePath, 'utf8').trim().toLowerCase();
            Logger.log(`AI State Change: ${content}`, 'CursorDetector');

            if (content === 'thinking') {
                if (this.onThinkingStartCallback) this.onThinkingStartCallback();
            } else if (content === 'idle') {
                if (this.onThinkingStopCallback) this.onThinkingStopCallback();
            }
        } catch (e) {
            Logger.error('Error reading state file', e, 'CursorDetector');
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
