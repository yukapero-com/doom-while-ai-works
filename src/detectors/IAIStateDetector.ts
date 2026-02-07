import * as vscode from 'vscode';

export interface IAIStateDetector extends vscode.Disposable {
    /**
     * AIが思考を開始した（または思考中である）ことを通知するイベント
     */
    onThinkingStart(callback: () => void): void;

    /**
     * AIが思考を停止したことを通知するイベント
     */
    onThinkingStop(callback: () => void): void;

    /**
     * 監視を開始する
     */
    start(): void;

    /**
     * 監視を停止する
     */
    stop(): void;
}
