import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as process from 'process';
import { IAIStateDetector } from './IAIStateDetector';
import { Logger } from '../utils/logger';

export class AntigravityDetector implements IAIStateDetector {
    private currentLogPath: string | null = null;
    private poller: NodeJS.Timeout | null = null;
    private currentSize: number = 0;
    private onThinkingStartCallback: (() => void) | null = null;
    private onThinkingStopCallback: (() => void) | null = null;

    constructor() { }

    public onThinkingStart(callback: () => void) {
        this.onThinkingStartCallback = callback;
    }

    public onThinkingStop(callback: () => void) {
        this.onThinkingStopCallback = callback;
    }

    public start() {
        this.startPolling();
    }

    public dispose() {
        this.stop();
    }

    private startPolling() {
        this.poller = setInterval(() => {
            this.checkLogs();
        }, 1000); // Check every second
    }

    public stop() {
        if (this.poller) {
            clearInterval(this.poller);
            this.poller = null;
        }
    }

    private async checkLogs() {
        try {
            // IF we don't have a log file yet, or if it stopped updating (maybe window closed), try to find the latest
            if (!this.currentLogPath) {
                this.currentLogPath = this.findLatestLogFile();
                if (this.currentLogPath) {
                    const stats = fs.statSync(this.currentLogPath);
                    this.currentSize = stats.size;
                    Logger.log(`latching onto: ${this.currentLogPath}`, 'AntigravityDetector');
                }
                return;
            }

            // Check for updates
            const stats = fs.statSync(this.currentLogPath);
            if (stats.size > this.currentSize) {
                // Read new content
                const stream = fs.createReadStream(this.currentLogPath, {
                    start: this.currentSize,
                    end: stats.size
                });

                let buffer = '';
                for await (const chunk of stream) {
                    buffer += chunk.toString();
                }

                this.currentSize = stats.size;
                this.analyzeChunk(buffer);
            } else if (stats.size < this.currentSize) {
                // File truncated or rotated? Reset.
                this.currentSize = stats.size;
            }

            // Check network if we have a tracking PID
            this.checkWatchdog();

        } catch (e) {
            // File might have disappeared
            Logger.error('Error reading log', e, 'AntigravityDetector');
            this.currentLogPath = null;
        }
    }

    private activePid: number | null = null;

    private hasPendingUserRequest: boolean = false;
    private isToolExecuting: boolean = false;
    private lastLogTime: number = 0;

    private analyzeChunk(chunk: string) {
        // Update watchdog timer if we have content
        if (chunk && chunk.trim().length > 0) {
            this.lastLogTime = Date.now();
        }

        // [DEBUG MODE] Output EVERYTHING to console
        const lines = chunk.split(/\r?\n/);
        for (const line of lines) {
            if (line.trim().length > 0) {
                // Pinpoint suppression for annoying internal error log
                if (line.includes('antigravity.getChromeDevtoolsMcpUrl')) {
                    continue;
                }

                Logger.log(`RAW LOG: ${line.trim()}`, 'AntigravityDetector');

                // 1. Check for User Intent (Start of Turn)
                if (line.includes('Requesting planner')) {
                    Logger.log('User Intent Detected (Requesting planner)', 'AntigravityDetector');
                    this.hasPendingUserRequest = true;
                    this.isToolExecuting = false;
                    this.lastLogTime = Date.now(); // Reset timer
                    if (this.onThinkingStartCallback) {
                        this.onThinkingStartCallback();
                    }
                }

                // 2. Extract PID if this is a request log AND we have a pending user request
                // Format: ... [info] I0131 ... <PID> http_helpers.go ... URL: ...streamGenerateContent...
                if (line.includes('streamGenerateContent')) {
                    if (this.hasPendingUserRequest) {
                        const match = line.match(/\s(\d+)\s+http_helpers\.go/);
                        if (match && match[1]) {
                            const pid = parseInt(match[1], 10);
                            if (!isNaN(pid) && pid !== this.activePid) {
                                Logger.log(`Detected Request PID: ${pid} (MATCHED USER INTENT)`, 'AntigravityDetector');
                                this.activePid = pid;
                                this.lastLogTime = Date.now(); // Reset timer

                                // Consume the intent
                                this.hasPendingUserRequest = false;

                                // Trigger activity immediately
                                if (this.onThinkingStartCallback) {
                                    this.onThinkingStartCallback();
                                }
                            }
                        }
                    } else {
                        // If we are seeing a request line but no User Intent was pending:
                        // 1. It might be the SAME request logged again (or sub-step). Check PID.
                        const match = line.match(/\s(\d+)\s+http_helpers\.go/);
                        const currentPid = (match && match[1]) ? parseInt(match[1], 10) : null;

                        if (currentPid && currentPid === this.activePid) {
                            Logger.log(`Ignoring duplicate start-log for active PID: ${currentPid}`, 'AntigravityDetector');
                            // Do nothing, just keep going.
                        } else {
                            Logger.log('Ignoring background request (No pending User Intent)', 'AntigravityDetector');
                            if (this.activePid) {
                                Logger.log('Force stopping previous request due to new background request.', 'AntigravityDetector');
                                this.fireStop();
                            }
                        }
                    }
                }
            }
        }

        // 3. Check for Stop Keywords (Explicit Completion Signals)
        const stopKeywords = [
            'PathsToReview',
            'BlockedOnUser'
        ];

        // "argument order was not respected" is actually a Tool Call signal, not a stop signal.
        if (chunk.includes('argument order was not respected')) {
            Logger.log('Tool Call Detected (argument order error). Bridge mode active.', 'AntigravityDetector');
            this.isToolExecuting = true;
            this.lastLogTime = Date.now();
        }

        if (stopKeywords.some(k => chunk.includes(k))) {
            Logger.log('Stop Signal Detected (Log Keyword)!', 'AntigravityDetector');
            this.fireStop();
            return;
        }
    }

    private checkWatchdog() {
        if (!this.activePid) return;

        // Watchdog: 10秒間ログ更新がない場合は終了と判定
        const LOG_TIMEOUT_MS = 10000;

        if (Date.now() - this.lastLogTime > LOG_TIMEOUT_MS) {
            Logger.log(`Watchdog Timeout! No log activity for ${LOG_TIMEOUT_MS}ms. Force stopping.`, 'AntigravityDetector');
            this.fireStop();
        }
    }

    private fireStop() {
        this.activePid = null;
        this.isToolExecuting = false;
        this.lastLogTime = 0;
        if (this.onThinkingStopCallback) {
            this.onThinkingStopCallback();
        }
    }

    private findLatestLogFile(): string | null {
        try {
            const home = os.homedir();
            let baseDir: string;
            if (process.platform === 'win32') {
                baseDir = path.join(process.env.APPDATA || '', 'Antigravity/logs');
            } else if (process.platform === 'darwin') {
                baseDir = path.join(home, 'Library/Application Support/Antigravity/logs');
            } else {
                // Linux / others
                baseDir = path.join(home, '.config/Antigravity/logs');
            }

            if (!fs.existsSync(baseDir)) return null;

            // 1. Find latest timestamp dir
            const dirs = fs.readdirSync(baseDir)
                .map(name => path.join(baseDir, name))
                .filter(p => fs.statSync(p).isDirectory())
                .sort((a, b) => fs.statSync(b).mtime.getTime() - fs.statSync(a).mtime.getTime());

            if (dirs.length === 0) return null;

            // Search recent dirs for the active window log
            // We search the top 3 dirs just in case
            for (const dir of dirs.slice(0, 3)) {
                const candidates = this.findLogFilesInDir(dir);
                if (candidates.length > 0) {
                    // Sort by mtime desc
                    candidates.sort((a, b) => fs.statSync(b).mtime.getTime() - fs.statSync(a).mtime.getTime());
                    return candidates[0];
                }
            }

        } catch (e) {
            Logger.error('Find Error', e, 'AntigravityDetector');
        }
        return null;
    }

    private findLogFilesInDir(dir: string): string[] {
        const results: string[] = [];
        const items = fs.readdirSync(dir);

        for (const item of items) {
            const fullPath = path.join(dir, item);
            const stats = fs.statSync(fullPath);

            if (stats.isDirectory()) {
                if (item.startsWith('window')) {
                    // Dive into window dir
                    results.push(...this.findLogFilesInDir(fullPath));
                } else if (item === 'exthost' || item === 'google.antigravity') {
                    results.push(...this.findLogFilesInDir(fullPath));
                }
            } else if (item === 'Antigravity.log') {
                results.push(fullPath);
            }
        }
        return results;
    }
}
