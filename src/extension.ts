import * as vscode from 'vscode';
import { IAIStateDetector } from './detectors/IAIStateDetector';
import { AntigravityDetector } from './detectors/AntigravityDetector';
import { VSCodeCopilotDetector } from './detectors/VSCodeCopilotDetector';
import { CursorDetector } from './detectors/CursorDetector';
import { DoomController } from './doomController';
import { Logger } from './utils/logger';

let statusBar: vscode.StatusBarItem;
let isThinking = false;
let isAIEnabled = true;
let aiDetector: IAIStateDetector;
let doomController: DoomController;
let activityTimer: NodeJS.Timeout | null = null;
let stopTimer: NodeJS.Timeout | null = null;
const ACTIVITY_TIMEOUT_MS = 10000;

export function activate(context: vscode.ExtensionContext) {
    // Initialize Logger first
    Logger.initialize('Doom While AI Works');
    Logger.log('Activated');

    const appName = vscode.env.appName;
    Logger.log(`Environment Check - AppName: "${appName}"`);

    // 0. Load AI State
    isAIEnabled = context.globalState.get<boolean>('doom-while-ai-works.isAIEnabled', true);

    // 1. Status Bar Setup
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'doom-while-ai-works.toggleAI';
    updateStatusBar();
    statusBar.show();
    context.subscriptions.push(statusBar);

    // 2. Doom Controller
    doomController = new DoomController(context);
    context.subscriptions.push(doomController);

    // 3. AI State Detector (Simple Switch)
    if (appName.includes('Cursor')) {
        Logger.log('Using CursorDetector');
        aiDetector = new CursorDetector(context);
    } else if (appName.includes('Antigravity')) { // Experimental check
        Logger.log('Using AntigravityDetector');
        aiDetector = new AntigravityDetector();
    } else {
        Logger.log('Defaulting to VSCodeCopilotDetector');
        aiDetector = new VSCodeCopilotDetector(context);
    }
    context.subscriptions.push(aiDetector);

    aiDetector.onThinkingStart(() => {
        handleActivity();
    });
    aiDetector.onThinkingStop(() => {
        // Disabled: Relying on ACTIVITY_TIMEOUT_MS for stopping
        // Logger.log('Stop Signal Received. Setting to Ready.');
        // setReady();
    });
    aiDetector.start();

    // 4. (Removed QuotaMonitor)

    // 5. Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('doom-while-ai-works.start', () => {
            Logger.log('Manual Start');
            isThinking = true; // Set thinking state manually
            updateStatusBar();
            doomController.start();
        }),
        vscode.commands.registerCommand('doom-while-ai-works.pause', () => {
            Logger.log('Manual Pause');
            setReady(); // Unified stop logic
        }),
        vscode.commands.registerCommand('doom-while-ai-works.toggleAI', async () => {
            isAIEnabled = !isAIEnabled;
            await context.globalState.update('doom-while-ai-works.isAIEnabled', isAIEnabled);
            Logger.log(`AI Integration toggled: ${isAIEnabled}`);
            updateStatusBar();

            // If turned off while thinking, stop the game
            if (!isAIEnabled && isThinking) {
                setReady();
            } else if (isAIEnabled && isThinking) {
                doomController.start();
            }
        }),
        vscode.commands.registerCommand('doom-while-ai-works.selectWad', async () => {
            const options: vscode.OpenDialogOptions = {
                canSelectMany: false,
                openLabel: 'Select WAD',
                filters: {
                    'Doom WAD Files': ['wad'],
                    'All Files': ['*']
                }
            };

            const fileUri = await vscode.window.showOpenDialog(options);
            if (fileUri && fileUri[0]) {
                const config = vscode.workspace.getConfiguration('doom-while-ai-works');
                await config.update('game.wadPath', fileUri[0].fsPath, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Selected WAD: ${fileUri[0].fsPath}. Please restart Doom to apply.`);
            }
        }),
        vscode.commands.registerCommand('doom-while-ai-works.showDebugInfo', () => {
            const detectorName = aiDetector ? aiDetector.constructor.name : 'None';
            const info = [
                `App Name: ${vscode.env.appName}`,
                `Detector: ${detectorName}`,
                `AI Enabled: ${isAIEnabled}`,
                `Thinking: ${isThinking}`
            ].join('\n');
            vscode.window.showInformationMessage('Doom While AI Works - Debug Info', { modal: true, detail: info });
        })
    );

    // Auto-start removed. Doom will start only when AI is thinking.
    // doomController.start();
}

export function deactivate() {
    if (aiDetector) aiDetector.stop();
    if (activityTimer) clearTimeout(activityTimer);
}

function handleActivity() {
    // 1. If currently Ready, switch to Thinking
    if (!isThinking) {
        Logger.log('Activity Started');
        setThinking();
    }

    // 3. Extend the fallback timeout
    if (activityTimer) {
        clearTimeout(activityTimer);
    }

    activityTimer = setTimeout(() => {
        Logger.log(`Activity Timeout (${ACTIVITY_TIMEOUT_MS}ms). Setting to Ready.`);
        setReady();
    }, ACTIVITY_TIMEOUT_MS);
}

function updateStatusBar() {
    if (!isAIEnabled) {
        statusBar.text = '🔴 Doom: OFF';
        statusBar.tooltip = 'Click to enable auto-Doom';
        statusBar.backgroundColor = undefined;
    } else {
        if (isThinking) {
            statusBar.text = '🔥 Doom: ACTIVE';
            statusBar.tooltip = 'Playing Doom while AI works!';
            statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            statusBar.text = '🟢 Doom: ON';
            statusBar.tooltip = 'Auto-Doom enabled. Waiting for AI...';
            statusBar.backgroundColor = undefined;
        }
    }
}

function setThinking() {
    isThinking = true;
    updateStatusBar();
    if (isAIEnabled) {
        doomController.start();
    }
}

function setReady() {
    if (!isThinking && activityTimer === null) {
        // Already ready and no timer pending
        return;
    }

    Logger.log('Transitioning to Ready state');
    isThinking = false;
    updateStatusBar();

    if (activityTimer) {
        clearTimeout(activityTimer);
        activityTimer = null;
    }

    doomController.stop();
}
