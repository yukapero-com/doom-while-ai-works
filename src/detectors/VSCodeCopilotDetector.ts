import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { IAIStateDetector } from './IAIStateDetector';
import { Logger } from '../utils/logger';

export class VSCodeCopilotDetector implements IAIStateDetector {
    private logPath: string | null = null;
    private poller: NodeJS.Timeout | null = null;
    private currentSize: number = 0;
    private onThinkingStartCallback: (() => void) | null = null;
    private onThinkingStopCallback: (() => void) | null = null;

    private readonly STARTUP_GRACE_PERIOD_MS = 5000;
    private startupTime: number = Date.now();

    constructor(private context: vscode.ExtensionContext) {
        this.resolveLogPath();
    }

    private resolveLogPath() {
        try {
            // context.logUri is something like:
            // .../Code/logs/YYYYMMDDTHHMMSS/window1/exthost/dom-hack.doom-while-ai-works

            const myLogPath = this.context.logUri.fsPath;
            const extHostDir = path.dirname(myLogPath); // .../exthost

            // Copilot Chat log should be at: .../exthost/GitHub.copilot-chat/GitHub Copilot Chat.log
            // We use path.join for OS-agnostic path handling
            this.logPath = path.join(
                extHostDir,
                'GitHub.copilot-chat',
                'GitHub Copilot Chat.log'
            );

            Logger.log(`Resolved log path: ${this.logPath}`, 'VSCodeCopilotDetector');
        } catch (e) {
            Logger.error('Failed to resolve log path', e, 'VSCodeCopilotDetector');
        }
    }

    public onThinkingStart(callback: () => void) {
        this.onThinkingStartCallback = callback;
    }

    public onThinkingStop(callback: () => void) {
        this.onThinkingStopCallback = callback;
    }

    public async start() {
        Logger.log('Starting polling (Log Only)...', 'VSCodeCopilotDetector');
        await this.checkDebugLogLevel();
        this.startPolling();
    }

    private async checkDebugLogLevel() {
        try {
            const config = vscode.workspace.getConfiguration('github.copilot');
            const advanced = config.get<any>('advanced') || {};
            const debugOverride = advanced.debug?.overrideLogLevels?.['*'];

            if (debugOverride !== 'DEBUG') {
                const selection = await vscode.window.showWarningMessage(
                    "Doing While AI Works: GitHub Copilot log level must be 'Debug' to detect activity. Please see README for setup instructions.",
                    "Open README",
                    "Ignore"
                );

                if (selection === "Open README") {
                    vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.join(this.context.extensionPath, 'README.md')));
                }
            }
        } catch (e) {
            Logger.error('Failed to check debug log level', e, 'VSCodeCopilotDetector');
        }
    }

    public stop() {
        if (this.poller) {
            clearInterval(this.poller);
            this.poller = null;
        }
    }

    public dispose() {
        this.stop();
    }

    private startPolling() {
        // Poll every 1 second
        this.poller = setInterval(() => {
            this.checkLogs();
        }, 1000);
    }

    private isThinking: boolean = false;
    private lastActivityTime: number = 0;
    private readonly SILENCE_TIMEOUT_MS = 60000; // 60 seconds silence timeout

    private checkLogs() {
        if (!this.logPath) {
            this.resolveLogPath();
        }

        // Check Logs (Chat Panel & Copilot Edits via Log)
        try {
            if (!this.logPath || !fs.existsSync(this.logPath)) {
                return;
            }

            const stats = fs.statSync(this.logPath);

            if (this.currentSize === 0) {
                // First time seeing the file, latch onto the end
                this.currentSize = stats.size;
                Logger.log(`Found log file. Initial size: ${this.currentSize}`, 'VSCodeCopilotDetector');
                return;
            }

            if (stats.size > this.currentSize) {
                // Read the new content
                const buffer = Buffer.alloc(stats.size - this.currentSize);
                const fd = fs.openSync(this.logPath, 'r');
                fs.readSync(fd, buffer, 0, buffer.length, this.currentSize);
                fs.closeSync(fd);

                const newContent = buffer.toString('utf8');
                this.currentSize = stats.size;

                this.parseLogContent(newContent);
            } else if (stats.size < this.currentSize) {
                // File truncated
                this.currentSize = stats.size;
                this.isThinking = false; // Reset state on truncation
            }

            // check timeout
            this.checkSilenceTimeout();

            // Active Heartbeat: Keep sending signals while thinking to prevent extension-side timeout (10s)
            if (this.isThinking && vscode.window.state.focused) {
                if (this.onThinkingStartCallback) this.onThinkingStartCallback();
            }

        } catch (e) {
            Logger.error('Error checking log:', e, 'VSCodeCopilotDetector');
        }
    }

    private parseLogContent(content: string) {
        const lines = content.split('\n');
        for (const line of lines) {
            // Start Triggers
            if (line.includes('[debug] AgentIntent:') || line.includes('[debug] GH request id:')) {
                if (!this.isThinking) {

                    // Grace Period Check for Logs
                    if (Date.now() - this.startupTime < this.STARTUP_GRACE_PERIOD_MS) {
                        Logger.log('Ignored Log Trigger (Grace Period)', 'VSCodeCopilotDetector');
                        continue;
                    }

                    Logger.log('Thinking Started (Log Trigger)', 'VSCodeCopilotDetector');
                    this.isThinking = true;
                    if (vscode.window.state.focused) {
                        if (this.onThinkingStartCallback) this.onThinkingStartCallback();
                    }
                }
                this.lastActivityTime = Date.now();
            }

            // Keep-Alive (Any log activity while thinking extends the session)
            if (this.isThinking) {
                this.lastActivityTime = Date.now();
            }

            // End Triggers
            if (line.includes('[info] request done:') || line.includes('[info] message 0 returned. finish reason:')) {
                if (this.isThinking) {
                    Logger.log('Thinking Stopped (Log Trigger)', 'VSCodeCopilotDetector');
                    this.isThinking = false;
                    // We let the Activity Timeout in extension.ts handle the actual stop
                }
            }

            // Additional End Triggers (for cases where "request done" is missing but "ccreq" summary is present)
            if (line.includes('ccreq:') && (line.includes('| success') || line.includes('| failure') || line.includes('| cancelled'))) {
                if (this.isThinking) {
                    Logger.log('Thinking Stopped (ccreq Trigger)', 'VSCodeCopilotDetector');
                    this.isThinking = false;
                }
            }
        }
    }

    private checkSilenceTimeout() {
        if (this.isThinking) {
            if (Date.now() - this.lastActivityTime > this.SILENCE_TIMEOUT_MS) {
                Logger.log(`Silence Timeout (${this.SILENCE_TIMEOUT_MS}ms). Forcing Thinking Stop.`, 'VSCodeCopilotDetector');
                this.isThinking = false;
            }
        }
    }

}
