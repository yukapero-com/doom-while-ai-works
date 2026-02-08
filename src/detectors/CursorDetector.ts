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

        // Ensure .cursor directory exists
        if (!fs.existsSync(cursorDir)) {
            try {
                fs.mkdirSync(cursorDir, { recursive: true });
            } catch (e) {
                Logger.error('Failed to create .cursor directory', e, 'CursorDetector');
            }
        }

        // Normalize path to use forward slashes for better compatibility
        this.stateFilePath = path.join(cursorDir, 'ai_thinking.txt').split(path.sep).join('/');

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
        // this.showSetupInstructions(); // Disabled for now to avoid annoyance? Or maybe keep it? Use original logic.
        this.showSetupInstructions();

        // 2. Start watching the bridge file
        this.startWatching();
    }

    public stop() {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        // Also stop fs.watchFile polling if it was used
        fs.unwatchFile(this.stateFilePath);
    }

    public dispose() {
        this.stop();
    }

    private startWatching() {
        try {
            // Check initial state
            this.checkState();

            // Hybrid watching strategy:
            // 1. Try fs.watch first (efficient, event-driven)
            // 2. Fallback/Concurrent fs.watchFile (polling) for stability on some Windows configs

            try {
                this.watcher = fs.watch(this.stateFilePath, (eventType, filename) => {
                    if (eventType === 'change') {
                        this.checkState();
                    }
                });

                this.watcher.on('error', (error) => {
                    Logger.error('fs.watch error', error, 'CursorDetector');
                    // Ensure we fallback to polling if watch fails
                    this.ensurePollingWatcher();
                });
            } catch (e) {
                Logger.error('Failed to setup fs.watch, falling back to polling', e, 'CursorDetector');
                this.ensurePollingWatcher();
            }

            // Always setup polling as a backup/hybrid for robustness on Windows
            this.ensurePollingWatcher();

        } catch (e) {
            Logger.error('Failed to start watcher', e, 'CursorDetector');
        }
    }

    private ensurePollingWatcher() {
        // fs.watchFile is a polling based watcher, more robust on network drives or some Windows setups
        fs.watchFile(this.stateFilePath, { interval: 500 }, (curr, prev) => {
            if (curr.mtimeMs !== prev.mtimeMs) {
                this.checkState();
            }
        });
    }

    private heartbeatInterval: NodeJS.Timeout | null = null;
    private stopDebounceTimer: NodeJS.Timeout | null = null;
    private readonly STOP_DEBOUNCE_MS = 5000;

    private checkState() {
        try {
            if (!fs.existsSync(this.stateFilePath)) {
                return;
            }

            const rawContent = fs.readFileSync(this.stateFilePath, 'utf8');
            // Normalize: Remove non-printable characters (BOM, etc), trim, lowercase
            const content = rawContent.replace(/[^\x20-\x7E]/g, '').trim().toLowerCase();

            // Use loose matching .includes instead of strict equality
            if (content.includes('thinking')) {
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
            const msg = 'Doom While AI Works: Cursor detected. To enable AI detection, you must configure Hooks. See README for details.';
            const openReadmeParams = 'Open README';
            const dontShowAgainParams = "Don't Show Again";
            const laterParams = "Later";

            const selection = await vscode.window.showInformationMessage(msg, openReadmeParams, dontShowAgainParams, laterParams);

            if (selection === openReadmeParams) {
                vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.join(this.context.extensionPath, 'README.md')));
            } else if (selection === dontShowAgainParams) {
                this.context.globalState.update(setupKey, true);
            }
        }
    }
}
