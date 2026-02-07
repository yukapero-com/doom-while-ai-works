import * as vscode from 'vscode';

export class Logger {
    private static outputChannel: vscode.OutputChannel | null = null;

    public static initialize(name: string) {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel(name);
        }
    }

    public static log(message: string, prefix: string = 'Extension') {
        const timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
        const formattedMessage = `[${timestamp}] [${prefix}] ${message}`;

        // Console still useful for extension development
        console.log(formattedMessage);

        if (this.outputChannel) {
            this.outputChannel.appendLine(formattedMessage);
        }
    }

    public static error(message: string, error?: any, prefix: string = 'Extension') {
        const timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
        const errMessage = error ? ` ${error.message || error}` : '';
        const formattedMessage = `[${timestamp}] [${prefix}] ERROR: ${message}${errMessage}`;

        console.error(formattedMessage);
        if (error?.stack) console.error(error.stack);

        if (this.outputChannel) {
            this.outputChannel.appendLine(formattedMessage);
            if (error?.stack) {
                this.outputChannel.appendLine(error.stack);
            }
        }
    }

    public static show() {
        this.outputChannel?.show();
    }

    public static getOutputChannel(): vscode.OutputChannel | null {
        return this.outputChannel;
    }
}
