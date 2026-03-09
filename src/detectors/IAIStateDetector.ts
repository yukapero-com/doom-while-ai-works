import * as vscode from 'vscode';

export interface IAIStateDetector extends vscode.Disposable {
    /**
     * Event fired when AI starts thinking (or is confirmed to be thinking)
     */
    onThinkingStart(callback: () => void): void;

    /**
     * Event fired when AI stops thinking
     */
    onThinkingStop(callback: () => void): void;

    /**
     * Start monitoring
     */
    start(): void;

    /**
     * Stop monitoring
     */
    stop(): void;
}
