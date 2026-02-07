import * as http from 'http';
import * as https from 'https';
import * as cp from 'child_process';

interface MonitorTarget {
    pid: number;
    port: number;
    token: string;
}

export class QuotaMonitor {
    private monitoredTargets: MonitorTarget[] = [];
    private pollingInterval: NodeJS.Timeout | null = null;

    // Config
    private readonly POLL_INTERVAL = 1000;

    constructor() { }

    public async start() {
        console.log('[QuotaMonitor] Starting discovery...');
        const processes = await this.findAllProcesses();

        if (processes.length === 0) {
            console.error('[QuotaMonitor] No Antigravity process found via pgrep.');
            return;
        }

        this.monitoredTargets = [];
        for (const proc of processes) {
            const ports = await this.findListeningPorts(proc.pid);
            if (ports.length === 0) continue;

            for (const port of ports) {
                const isValid = await this.validatePort(port, proc.token);
                if (isValid) {
                    console.log(`[QuotaMonitor] SUCCESS - Found Endpoint: PID=${proc.pid} Port=${port}`);
                    this.monitoredTargets.push({ pid: proc.pid, port, token: proc.token });
                    break;
                }
            }
        }

        if (this.monitoredTargets.length === 0) {
            console.error('[QuotaMonitor] Failed to bind to any API endpoint.');
            return;
        }

        console.log(`[QuotaMonitor] Started polling loop on ${this.monitoredTargets.length} targets.`);

        this.pollingInterval = setInterval(async () => {
            await this.pollTargets();
        }, this.POLL_INTERVAL);
    }

    public stop() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    private async pollTargets() {
        for (const target of this.monitoredTargets) {
            try {
                const data: any = await this.fetchQuota(target);
                this.analyzeQuotaResponse(data);
            } catch (e: any) {
                // Ignore fetch errors during polling
            }
        }
    }

    private analyzeQuotaResponse(data: any) {
        if (!data || !data.userStatus) return;

        // Check for 'planStatus' which contains 'availablePromptCredits'
        if (data.userStatus.planStatus) {
            console.log(`[QuotaMonitor] PlanStatus: ${JSON.stringify(data.userStatus.planStatus)}`);
        }

        // Also check model configs just in case
        if (data.userStatus.cascadeModelConfigData?.clientModelConfigs) {
            const models = data.userStatus.cascadeModelConfigData.clientModelConfigs;
            for (const m of models) {
                if (m.modelOrAlias?.model?.includes('claude')) {
                    // Logic for Claude specific quota if needed
                }
            }
        }
    }

    // --- Helpers ---
    private async findAllProcesses(): Promise<{ pid: number, token: string }[]> {
        return new Promise((resolve) => {
            const cmd = `pgrep -fl language_server`;
            cp.exec(cmd, (err, stdout) => {
                if (err) { resolve([]); return; }
                const lines = stdout.split('\n');
                const candidates: { pid: number, token: string }[] = [];
                for (const line of lines) {
                    const tokenMatch = line.match(/--csrf_token[=\s]+([a-zA-Z0-9\-]+)/);
                    if (!tokenMatch) continue;
                    const parts = line.trim().split(' ');
                    const pid = parseInt(parts[0]);
                    const token = tokenMatch[1];
                    if (!isNaN(pid)) candidates.push({ pid, token });
                }
                resolve(candidates);
            });
        });
    }

    private async findListeningPorts(pid: number): Promise<number[]> {
        return new Promise((resolve) => {
            const cmd = `lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid}`;
            cp.exec(cmd, (err, stdout) => {
                if (err) { resolve([]); return; }
                const ports: number[] = [];
                const lines = stdout.split('\n');
                for (const line of lines) {
                    const match = line.match(/:(\d+)\s+\(LISTEN\)/);
                    if (match) {
                        const p = parseInt(match[1]);
                        if (!ports.includes(p)) ports.push(p);
                    }
                }
                resolve(ports);
            });
        });
    }

    private validatePort(port: number, token: string): Promise<boolean> {
        return new Promise((resolve) => {
            const options = this.getRequestOptions(port, token);
            const req = https.request(options, (res: http.IncomingMessage) => {
                resolve(res.statusCode === 200);
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.write(JSON.stringify({}));
            req.end();
        });
    }

    private fetchQuota(target: MonitorTarget): Promise<any> {
        return new Promise((resolve, reject) => {
            const options = this.getRequestOptions(target.port, target.token);
            const req = https.request(options, (res: http.IncomingMessage) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode !== 200) { reject(); return; }
                    try { resolve(JSON.parse(body)); } catch { reject(); }
                });
            });
            req.on('error', reject);
            req.write(JSON.stringify({
                metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' }
            }));
            req.end();
        });
    }

    private getRequestOptions(port: number, token: string) {
        return {
            hostname: '127.0.0.1',
            port: port,
            path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
            method: 'POST',
            rejectUnauthorized: false,
            headers: {
                'Content-Type': 'application/json',
                'X-Codeium-Csrf-Token': token,
                'Connect-Protocol-Version': '1'
            }
        };
    }
}
